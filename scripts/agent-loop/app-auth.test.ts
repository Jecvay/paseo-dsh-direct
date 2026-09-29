import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  REFRESH_MARGIN_MS,
  TokenCache,
  appJwtClaims,
  botIdentity,
  identityEnv,
  parseInstallationToken,
  pushAuth,
  signAppJwt,
} from './app-auth.ts'

const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

describe('app JWT', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

  it('backdates iat by 60 s and keeps exp within 10 minutes', () => {
    const claims = appJwtClaims('123', 1_000_000.7)
    assert.deepEqual(claims, { iat: 999_940, exp: 1_000_540, iss: '123' })
    assert.ok(claims.exp - claims.iat <= 600)
    assert.ok(claims.exp - 1_000_000 <= 600)
  })

  it('is an RS256 JWT with base64url parts and a valid signature', () => {
    const jwt = signAppJwt('123', pem, 1_000_000)
    const parts = jwt.split('.')
    assert.equal(parts.length, 3)
    for (const part of parts) assert.match(part, /^[A-Za-z0-9_-]+$/)
    assert.deepEqual(decode(parts[0]), { alg: 'RS256', typ: 'JWT' })
    assert.deepEqual(decode(parts[1]), { iat: 999_940, exp: 1_000_540, iss: '123' })
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(publicKey, Buffer.from(parts[2], 'base64url'))
    assert.equal(ok, true)
  })

  it('accepts PKCS#8 keys too', () => {
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const [h, p, sig] = signAppJwt('9', pkcs8, 50).split('.')
    assert.equal(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')), true)
  })
})

describe('installation token cache', () => {
  const HOUR = 60 * 60 * 1000

  it('mints once and reuses the token until 5 minutes before expiry', () => {
    let minted = 0
    const cache = new TokenCache(() => ({ token: `t${++minted}`, expiresAt: minted * HOUR }))
    assert.equal(cache.get(0), 't1')
    assert.equal(cache.get(HOUR - REFRESH_MARGIN_MS - 1), 't1')
    assert.equal(minted, 1)
    assert.equal(cache.get(HOUR - REFRESH_MARGIN_MS), 't2')
    assert.equal(cache.get(HOUR + 1), 't2')
    assert.equal(minted, 2)
  })

  it('refuses an incomplete response and keeps no token', () => {
    let calls = 0
    const cache = new TokenCache(() => { calls++; return { token: '', expiresAt: Number.NaN } })
    assert.throws(() => cache.get(0), /不完整/)
    assert.throws(() => cache.get(0), /不完整/)
    assert.equal(calls, 2)
  })

  it('parses the access_tokens response', () => {
    assert.deepEqual(parseInstallationToken('{"token":"ghs_x","expires_at":"2026-09-29T12:00:00Z"}'), { token: 'ghs_x', expiresAt: Date.parse('2026-09-29T12:00:00Z') })
    assert.throws(() => parseInstallationToken('{"message":"Bad credentials"}'), /Bad credentials/)
  })
})

describe('bot identity', () => {
  it('uses the bot noreply address for author and committer', () => {
    const identity = botIdentity('paseo-dsh-agent', 4242)
    assert.deepEqual(identity, { name: 'paseo-dsh-agent[bot]', email: '4242+paseo-dsh-agent[bot]@users.noreply.github.com' })
    assert.deepEqual(identityEnv(identity), {
      GIT_AUTHOR_NAME: 'paseo-dsh-agent[bot]', GIT_AUTHOR_EMAIL: '4242+paseo-dsh-agent[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'paseo-dsh-agent[bot]', GIT_COMMITTER_EMAIL: '4242+paseo-dsh-agent[bot]@users.noreply.github.com',
    })
  })
})

describe('push credentials', () => {
  it('keeps the token out of argv and hands it to git only through the helper', () => {
    const auth = pushAuth('ghs_secret')
    assert.ok(!auth.config.join(' ').includes('ghs_secret'))
    assert.equal(auth.env.PASEO_AGENT_PUSH_TOKEN, 'ghs_secret')
    assert.equal(auth.env.GIT_CONFIG_GLOBAL, '/dev/null')

    // Ask git itself what credential it would send, without any network.
    const dir = mkdtempSync(join(tmpdir(), 'push-auth-'))
    try {
      spawnSync('git', ['init', '--quiet', dir])
      const result = spawnSync('git', [...auth.config, 'credential', 'fill'], {
        cwd: dir,
        input: 'protocol=https\nhost=github.com\npath=Jecvay/paseo-dsh-direct.git\n\n',
        env: { PATH: process.env.PATH, HOME: dir, ...auth.env },
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /^username=x-access-token$/m)
      assert.match(result.stdout, /^password=ghs_secret$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
