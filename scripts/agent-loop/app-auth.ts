/**
 * GitHub App identity of the agent loop (the `paseo-dsh-agent` App): the
 * app JWT, the installation-token cache and the commit identity of the bot
 * user. No network I/O here; `main.ts` supplies the HTTP calls.
 * Design: .agents/notes/implemented/process/2026-09-29-github-driven-agent-loop.md
 */

import { createSign } from 'node:crypto'

/** Default App slug; the bot user is `<slug>[bot]`. */
export const APP_SLUG = 'paseo-dsh-agent'

export interface AppConfig {
  /** GitHub App ID (the JWT issuer). */
  id: string
  /** Absolute path of the App's PEM private key. */
  privateKeyPath: string
  /** App slug; the bot login is `<slug>[bot]`. */
  slug: string
}

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url')

export interface AppJwtClaims { iat: number; exp: number; iss: string }

/**
 * Claims GitHub wants: `iat` 60 s in the past against clock drift, `exp`
 * at most 10 minutes after `iat`.
 */
export function appJwtClaims(appId: string, nowSeconds: number): AppJwtClaims {
  const iat = Math.floor(nowSeconds) - 60
  return { iat, exp: iat + 600, iss: appId }
}

/** RS256-signed app JWT, used only to ask for installation tokens. */
export function signAppJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify(appJwtClaims(appId, nowSeconds)))
  const input = `${header}.${payload}`
  const signature = createSign('RSA-SHA256').update(input).sign(privateKeyPem)
  return `${input}.${base64url(signature)}`
}

export interface InstallationToken { token: string; expiresAt: number }

/** Refresh this long before GitHub's expiry (installation tokens live 1 h). */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000

/** Holds one installation token in memory and mints a new one 5 minutes before it expires. */
export class TokenCache {
  private current: InstallationToken | undefined
  constructor(private readonly mint: () => InstallationToken) {}

  get(nowMs: number = Date.now()): string {
    if (!this.current || nowMs >= this.current.expiresAt - REFRESH_MARGIN_MS) {
      const next = this.mint()
      if (!next.token || !Number.isFinite(next.expiresAt)) throw new Error('GitHub 返回的 installation token 不完整')
      this.current = next
    }
    return this.current.token
  }
}

/** Parse the `POST /app/installations/{id}/access_tokens` response. */
export function parseInstallationToken(json: string): InstallationToken {
  const data = JSON.parse(json) as { token?: unknown; expires_at?: unknown; message?: unknown }
  if (typeof data.token !== 'string' || typeof data.expires_at !== 'string') {
    throw new Error(`换取 installation token 失败：${typeof data.message === 'string' ? data.message : '响应里没有 token'}`)
  }
  return { token: data.token, expiresAt: Date.parse(data.expires_at) }
}

export function botLogin(slug: string): string {
  return `${slug}[bot]`
}

/** Author and committer of the commits the agent makes. */
export function botIdentity(slug: string, userId: number): { name: string; email: string } {
  const login = botLogin(slug)
  return { name: login, email: `${userId}+${login}@users.noreply.github.com` }
}

/** Environment that makes git author and commit as the bot. */
export function identityEnv(identity: { name: string; email: string }): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  }
}

/**
 * git arguments and environment for one push as the App. The token lives
 * only in this process's environment: a credential helper that echoes it
 * back (the helper text itself holds no secret), global and system git
 * config ignored so no other helper stores it or rewrites the URL.
 */
export function pushAuth(token: string): { config: string[]; env: Record<string, string> } {
  return {
    config: [
      '-c', 'credential.helper=',
      '-c', 'credential.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$PASEO_AGENT_PUSH_TOKEN"; }; f',
      '-c', 'credential.useHttpPath=false',
    ],
    env: { PASEO_AGENT_PUSH_TOKEN: token, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }
}
