import type { Auth } from './createAuth'
import type { RequestLike, ResponseLike } from './index'
import { createOAuthUris } from '../oauth/utils'
import {
  CALLBACK_URI_COOKIE_NAME,
  Cookies,
  CSRF_COOKIE_NAME,
  CSRF_MAX_AGE,
  parseCookies,
  PKCE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from './cookies'
import { json, redirect } from './index'

async function handleSignIn(request: RequestLike, auth: Auth, providerId: string): Promise<ResponseLike> {
  const provider = auth.providerMap.get(providerId)
  if (!provider)
    return json({ error: 'Provider not found' }, { status: 400 })

  const { state: originalState, codeVerifier } = createOAuthUris()
  const url = new URL(request.url)
  const redirectTo = url.searchParams.get('redirectTo')
  const state = redirectTo ? `${originalState}.${btoa(redirectTo)}` : originalState
  let callbackUri = url.searchParams.get('callbackUri')
  if (!callbackUri && provider.requiresRedirectUri)
    callbackUri = `${url.origin}${auth.basePath}/${providerId}/callback`

  const authUrl = await provider.getAuthorizationUrl(state, codeVerifier, {
    redirectUri: callbackUri ?? undefined,
  })

  const requestCookies = parseCookies(request.headers.get('Cookie'))
  const cookies = new Cookies(requestCookies, auth.cookieOptions)

  cookies.set(CSRF_COOKIE_NAME, originalState, { maxAge: CSRF_MAX_AGE, sameSite: 'none' })
  cookies.set(PKCE_COOKIE_NAME, codeVerifier, { maxAge: CSRF_MAX_AGE, sameSite: 'none' })
  if (callbackUri)
    cookies.set(CALLBACK_URI_COOKIE_NAME, callbackUri, { maxAge: CSRF_MAX_AGE, sameSite: 'none' })

  const redirectParam = url.searchParams.get('redirect')

  if (redirectParam === 'false') {
    const response = json({ url: authUrl.toString() })
    cookies.toHeaders().forEach((value, key) => {
      response.headers.append(key, value)
    })
    return response
  }

  const response = redirect(authUrl.toString())
  cookies.toHeaders().forEach((value, key) => {
    response.headers.append(key, value)
  })

  return response
}

async function handleCallback(request: RequestLike, auth: Auth, providerId: string): Promise<ResponseLike> {
  const provider = auth.providerMap.get(providerId)
  if (!provider)
    return json({ error: 'Provider not found' }, { status: 400 })

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (!code || !state)
    return json({ error: 'Missing code or state' }, { status: 400 })

  const requestCookies = parseCookies(request.headers.get('Cookie'))
  const cookies = new Cookies(requestCookies, auth.cookieOptions)

  let savedState: string | undefined
  let redirectTo = '/'
  if (state.includes('.')) {
    const [originalSavedState, encodedRedirect] = state.split('.')
    savedState = originalSavedState
    try {
      redirectTo = atob(encodedRedirect ?? '') || '/'
    }
    catch {
      redirectTo = '/'
    }
  }
  else {
    savedState = state
  }

  const csrfToken = cookies.get(CSRF_COOKIE_NAME)

  if (!csrfToken || csrfToken !== savedState)
    return json({ error: 'Invalid CSRF token' }, { status: 403 })

  const codeVerifier = cookies.get(PKCE_COOKIE_NAME)
  if (!codeVerifier)
    return json({ error: 'Missing PKCE code verifier' }, { status: 400 })

  const callbackUri = cookies.get(CALLBACK_URI_COOKIE_NAME)

  const { user: providerUser, tokens } = await provider.validateCallback(code, codeVerifier, callbackUri ?? undefined)

  const userFromAccount = await auth.getUserByAccount(providerId, providerUser.id)

  let user = userFromAccount

  if (!user) {
    const autoLink = auth.autoLink ?? 'verifiedEmail'
    const shouldLinkByEmail = providerUser.email && (
      (autoLink === 'always')
      || (autoLink === 'verifiedEmail' && providerUser.emailVerified === true)
    )
    if (shouldLinkByEmail) {
      const existingUser = await auth.getUserByEmail(providerUser.email!)
      if (existingUser) {
        // If the email is verified by the new provider, and the existing user's email is not,
        // update the user's email verification status.
        if (providerUser.emailVerified && !existingUser.emailVerified) {
          user = await auth.updateUser({
            id: existingUser.id,
            emailVerified: true,
          })
        }
        else {
          user = existingUser
        }
      }
    }
    if (!user) {
      try {
        user = await auth.createUser({
          name: providerUser.name,
          email: providerUser.email,
          image: providerUser.avatar,
          emailVerified: providerUser.emailVerified,
        })
      }
      catch (error) {
        console.error('Failed to create user:', error)
        return json({ error: 'Failed to create user' }, { status: 500 })
      }
    }
  }

  if (!userFromAccount) {
    // GitHub sometimes doesn't return these which causes arctic to throw an error
    let refreshToken: string | null
    try {
      refreshToken = tokens.refreshToken()
    }
    catch {
      refreshToken = null
    }

    let expiresAt: number | undefined
    try {
      const expiresAtDate = tokens.accessTokenExpiresAt()
      if (expiresAtDate)
        expiresAt = Math.floor(expiresAtDate.getTime() / 1000)
    }
    catch {
    }

    let idToken: string | null
    try {
      idToken = tokens.idToken()
    }
    catch {
      idToken = null
    }

    try {
      await auth.linkAccount({
        userId: user.id,
        provider: providerId,
        providerAccountId: providerUser.id,
        accessToken: tokens.accessToken(),
        refreshToken,
        expiresAt,
        tokenType: tokens.tokenType?.() ?? null,
        scope: tokens.scopes()?.join(' ') ?? null,
        idToken,
      })
    }
    catch (error) {
      console.error('Error linking account:', error)
      return json({ error: 'Failed to link account' }, { status: 500 })
    }
  }

  const sessionToken = await auth.createSession(user.id)

  const requestUrl = new URL(request.url)
  const redirectUrl = new URL(redirectTo)

  const isDesktopRedirect = redirectUrl.protocol === 'gau:'
  const isMobileRedirect = requestUrl.host !== redirectUrl.host

  // For Tauri, we can't set a cookie on a custom protocol or a different host,
  // so we pass the token in the URL. Additionally, return a small HTML page
  // that immediately navigates to the deep-link and attempts to close the window,
  // so the external OAuth tab does not stay open.
  if (isDesktopRedirect || isMobileRedirect) {
    const destination = new URL(redirectTo)
    destination.searchParams.set('token', sessionToken)

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Authentication Complete</title>
  <style>
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      background-color: #09090b;
      color: #fafafa;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
    .card {
      background-color: #18181b;
      border: 1px solid #27272a;
      border-radius: 0.75rem;
      padding: 2rem;
      max-width: 320px;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 0.5rem;
    }
    p {
      margin: 0;
      color: #a1a1aa;
    }
  </style>
  <script>
    window.onload = function() {
      const url = ${JSON.stringify(destination.toString())};
      window.location.href = url;
      setTimeout(window.close, 500);
    };
  </script>
</head>
<body>
  <div class="card">
    <h1>Authentication Successful</h1>
    <p>You can now close this window.</p>
  </div>
</body>
</html>`

    // Clear temporary cookies (CSRF/PKCE/Callback URI) so they don't linger
    cookies.delete(CSRF_COOKIE_NAME)
    cookies.delete(PKCE_COOKIE_NAME)
    if (callbackUri)
      cookies.delete(CALLBACK_URI_COOKIE_NAME)

    const response = new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
    cookies.toHeaders().forEach((value, key) => {
      response.headers.append(key, value)
    })
    return response
  }

  cookies.set(SESSION_COOKIE_NAME, sessionToken, { maxAge: auth.jwt.ttl, sameSite: 'none', secure: true })
  cookies.delete(CSRF_COOKIE_NAME)
  cookies.delete(PKCE_COOKIE_NAME)
  if (callbackUri)
    cookies.delete(CALLBACK_URI_COOKIE_NAME)

  const redirectParam = url.searchParams.get('redirect')

  let response: Response
  if (redirectParam === 'false')
    response = json({ user })
  else
    response = redirect(redirectTo)

  cookies.toHeaders().forEach((value, key) => {
    response.headers.append(key, value)
  })

  return response
}

async function handleSession(request: RequestLike, auth: Auth): Promise<ResponseLike> {
  const rawCookieHeader = request.headers.get('Cookie')
  const requestCookies = parseCookies(rawCookieHeader)
  let sessionToken = requestCookies.get(SESSION_COOKIE_NAME)

  if (!sessionToken) {
    const authHeader = request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer '))
      sessionToken = authHeader.substring(7)
  }

  if (!sessionToken)
    return json({ user: null, session: null }, { status: 401 })

  try {
    const { user, session } = await auth.validateSession(sessionToken)

    if (!user || !session)
      return json({ user: null, session: null }, { status: 401 })

    return json({ user, session })
  }
  catch (error) {
    console.error('Error validating session:', error)
    return json({ error: 'Failed to validate session' }, { status: 500 })
  }
}

async function handleSignOut(request: RequestLike, auth: Auth): Promise<ResponseLike> {
  const requestCookies = parseCookies(request.headers.get('Cookie'))
  const cookies = new Cookies(requestCookies, auth.cookieOptions)
  cookies.delete(SESSION_COOKIE_NAME, { sameSite: 'none', secure: true })

  const response = json({ message: 'Signed out' })
  cookies.toHeaders().forEach((value, key) => {
    response.headers.append(key, value)
  })

  return response
}

export function createHandler(auth: Auth): (request: RequestLike) => Promise<ResponseLike> {
  const { providerMap, basePath } = auth

  function applyCors(request: RequestLike, response: Response): Response {
    const origin = request.headers.get('Origin') || request.headers.get('origin')
    if (!origin)
      return response
    response.headers.set('Access-Control-Allow-Origin', origin)
    response.headers.set('Vary', 'Origin')
    response.headers.set('Access-Control-Allow-Credentials', 'true')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie')
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    return response
  }

  return async function (request: RequestLike): Promise<ResponseLike> {
    // Handle preflight requests early
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') || request.headers.get('origin') || '*'
      const res = new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        },
      })
      return res
    }

    const url = new URL(request.url)
    if (!url.pathname.startsWith(basePath))
      return applyCors(request, json({ error: 'Not Found' }, { status: 404 }))

    if (request.method === 'POST' && !verifyRequestOrigin(request, auth.trustHosts))
      return applyCors(request, json({ error: 'Forbidden' }, { status: 403 }))

    const path = url.pathname.substring(basePath.length)
    const parts = path.split('/').filter(Boolean)
    const action = parts[0]

    if (!action)
      return applyCors(request, json({ error: 'Not Found' }, { status: 404 }))

    let response: ResponseLike

    if (request.method === 'GET') {
      if (providerMap.has(action)) {
        if (parts.length === 2 && parts[1] === 'callback')
          response = await handleCallback(request, auth, action)
        else if (parts.length === 1)
          response = await handleSignIn(request, auth, action)
        else
          response = json({ error: 'Not Found' }, { status: 404 })
      }
      else if (parts.length === 1 && action === 'session') {
        response = await handleSession(request, auth)
      }
      else {
        response = json({ error: 'Not Found' }, { status: 404 })
      }
    }
    else if (request.method === 'POST') {
      if (parts.length === 1 && action === 'signout')
        response = await handleSignOut(request, auth)
      else
        response = json({ error: 'Not Found' }, { status: 404 })
    }
    else {
      response = json({ error: 'Method Not Allowed' }, { status: 405 })
    }

    return applyCors(request, response as Response)
  }
}

function verifyRequestOrigin(request: RequestLike, trustHosts: 'all' | string[]): boolean {
  if (trustHosts === 'all')
    return true

  const origin = request.headers.get('origin')

  if (!origin)
    return false

  let originHost: string
  try {
    originHost = new URL(origin).host
  }
  catch {
    return false
  }

  const requestUrl = new URL(request.url)
  const requestHost = requestUrl.host
  const requestOrigin = `${requestUrl.protocol}//${requestHost}`

  if (origin === requestOrigin)
    return true

  return trustHosts.includes(originHost)
}
