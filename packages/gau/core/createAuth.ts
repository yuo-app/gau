import type { SerializeOptions } from 'cookie'
import type { SignOptions, VerifyOptions } from '../jwt'
import type { OAuthProvider } from '../oauth'
import type { Adapter, User } from './index'
import { sign, verify } from '../jwt'
import { DEFAULT_COOKIE_SERIALIZE_OPTIONS } from './cookies'
import { AuthError } from './index'

export interface CreateAuthOptions {
  /** The database adapter to use for storing users and accounts. */
  adapter: Adapter
  /** Array of OAuth providers to support. */
  providers: OAuthProvider[]
  /** Base path for authentication routes (defaults to '/api/auth'). */
  basePath?: string
  /** Configuration for JWT signing and verification. */
  jwt?: {
    /** Signing algorithm: 'ES256' (default) or 'HS256'. */
    algorithm?: 'ES256' | 'HS256'
    /** Secret for HS256 or base64url-encoded private key for ES256 (overrides AUTH_SECRET). */
    secret?: string
    /** Issuer claim (iss) for JWTs. */
    iss?: string
    /** Audience claim (aud) for JWTs. */
    aud?: string
    /** Default time-to-live in seconds for JWTs (defaults to 1 day). */
    ttl?: number
  }
  /** Custom options for session cookies. */
  cookies?: Partial<SerializeOptions>
  /** Trusted hosts for CSRF protection: 'all' or array of hostnames (defaults to []). */
  trustHosts?: 'all' | string[]
  /** Account linking behavior: 'verifiedEmail' (default), 'always', or false. */
  autoLink?: 'verifiedEmail' | 'always' | false
}

export type Auth = Adapter & {
  providerMap: Map<string, OAuthProvider>
  basePath: string
  cookieOptions: SerializeOptions
  jwt: {
    ttl: number
  }
  signJWT: <T extends Record<string, unknown>>(payload: T, customOptions?: Partial<SignOptions>) => Promise<string>
  verifyJWT: <T = Record<string, unknown>>(token: string, customOptions?: Partial<VerifyOptions>) => Promise<T | null>
  createSession: (userId: string, data?: Record<string, unknown>, ttl?: number) => Promise<string>
  validateSession: (token: string) => Promise<{
    user: User | null
    session: { id: string, sub: string, [key: string]: any } | null
  }>
  trustHosts: 'all' | string[]
  autoLink: 'verifiedEmail' | 'always' | false
}

export function createAuth(options: CreateAuthOptions): Auth {
  const { adapter, providers, basePath = '/api/auth', jwt: jwtConfig = {}, cookies: cookieConfig = {}, trustHosts = options.trustHosts ?? [], autoLink = 'verifiedEmail' } = options
  const { algorithm = 'ES256', secret, iss, aud, ttl: defaultTTL = 3600 * 24 } = jwtConfig

  const cookieOptions = { ...DEFAULT_COOKIE_SERIALIZE_OPTIONS, ...cookieConfig }

  const providerMap = new Map(providers.map(p => [p.id, p]))

  function buildSignOptions(custom: Partial<SignOptions> = {}): SignOptions {
    const base = { ttl: custom.ttl, iss: custom.iss ?? iss, aud: custom.aud ?? aud, sub: custom.sub }
    if (algorithm === 'HS256') {
      return { algorithm, secret: custom.secret ?? secret, ...base }
    }
    else {
      const esSecret = custom.secret ?? secret
      if (esSecret !== undefined && typeof esSecret !== 'string')
        throw new AuthError('For ES256, the secret option must be a string.')
      return { algorithm, privateKey: custom.privateKey, secret: esSecret, ...base }
    }
  }

  function buildVerifyOptions(custom: Partial<VerifyOptions> = {}): VerifyOptions {
    const base = { iss: custom.iss ?? iss, aud: custom.aud ?? aud }
    if (algorithm === 'HS256') {
      return { algorithm, secret: custom.secret ?? secret, ...base }
    }
    else {
      const esSecret = custom.secret ?? secret
      if (esSecret !== undefined && typeof esSecret !== 'string')
        throw new AuthError('For ES256, the secret option must be a string.')
      return { algorithm, publicKey: custom.publicKey, secret: esSecret, ...base }
    }
  }

  async function signJWT<T extends Record<string, unknown>>(payload: T, customOptions: Partial<SignOptions> = {}): Promise<string> {
    return sign(payload, buildSignOptions(customOptions))
  }

  async function verifyJWT<T = Record<string, unknown>>(token: string, customOptions: Partial<VerifyOptions> = {}): Promise<T | null> {
    try {
      return await verify<T>(token, buildVerifyOptions(customOptions))
    }
    catch {
      return null
    }
  }

  async function createSession(userId: string, data: Record<string, unknown> = {}, ttl = defaultTTL): Promise<string> {
    const payload = { sub: userId, ...data }
    return signJWT(payload, { ttl })
  }

  async function validateSession(token: string): Promise<{ user: User | null, session: { id: string, sub: string, [key: string]: unknown } | null }> {
    const payload = await verifyJWT<{ sub: string } & Record<string, unknown>>(token)
    if (!payload)
      return { user: null, session: null }
    const user = await adapter.getUser(payload.sub)
    return { user, session: { id: token, ...payload } }
  }

  return {
    ...adapter,
    providerMap,
    basePath,
    cookieOptions,
    jwt: {
      ttl: defaultTTL,
    },
    signJWT,
    verifyJWT,
    createSession,
    validateSession,
    trustHosts,
    autoLink,
  }
}
