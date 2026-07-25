import assert from 'node:assert/strict'
import test from 'node:test'

import worker, { __testing__ } from '../src/index.ts'

const API_KEY = 'test-upload-key-that-is-long-enough'
const SITE_DOMAIN = 'preview.example.com'

class MockR2ObjectBody {
  constructor(key, record) {
    this.key = key
    this.size = record.bytes.byteLength
    this.body = record.bytes
    this.httpMetadata = record.httpMetadata
    this.httpEtag = `"${record.etag}"`
  }

  async text() {
    return new TextDecoder().decode(this.body)
  }
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map()
    this.failNextPut = false
  }

  async put(key, value, options = {}) {
    if (this.failNextPut) {
      this.failNextPut = false
      throw new Error('private storage detail')
    }

    let bytes
    if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value)
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value)
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    } else {
      throw new Error('unsupported test body')
    }

    const stored = new Uint8Array(bytes)
    this.objects.set(key, {
      bytes: stored,
      httpMetadata: options.httpMetadata ?? {},
      etag: `${stored.byteLength}-${key}`,
    })
    return { key }
  }

  async get(key) {
    const record = this.objects.get(key)
    return record ? new MockR2ObjectBody(key, record) : null
  }

  async list({ prefix = '' } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, record]) => ({
        key,
        size: record.bytes.byteLength,
      }))

    return {
      objects,
      truncated: false,
      cursor: undefined,
    }
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key)
    }
  }
}

function createHarness() {
  const bucket = new MockR2Bucket()
  const pending = []
  const context = {
    waitUntil(promise) {
      pending.push(promise)
    },
    passThroughOnException() {},
  }
  const env = {
    BYTRO_PREVIEW_BUCKET: bucket,
    UPLOAD_API_KEY: API_KEY,
    SITE_DOMAIN,
  }
  return { bucket, context, env, pending }
}

function apiRequest(path, body, method = 'POST', apiKey = API_KEY) {
  return new Request(`https://${SITE_DOMAIN}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      Origin: 'https://tauri.localhost',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function encode(value) {
  return Buffer.from(value).toString('base64')
}

async function upload(harness, siteId, deploymentId, files) {
  return worker.fetch(
    apiRequest('/api/deploy', {
      siteId,
      deploymentId,
      files: files.map(([path, content, contentType = 'text/plain']) => ({
        path,
        content: encode(content),
        contentType,
      })),
    }),
    harness.env,
    harness.context,
  )
}

async function finalize(harness, siteId, deploymentId) {
  return worker.fetch(
    apiRequest('/api/deploy/finalize', { siteId, deploymentId }),
    harness.env,
    harness.context,
  )
}

async function getSite(harness, siteId, path = '/', accept = 'text/html') {
  return worker.fetch(
    new Request(`https://${siteId}.${SITE_DOMAIN}${path}`, {
      headers: { Accept: accept },
    }),
    harness.env,
    harness.context,
  )
}

test('rejects missing credentials, foreign hosts, and reserved site IDs', async () => {
  const harness = createHarness()
  const deploymentId = '1'.repeat(32)

  const unauthorized = await worker.fetch(
    apiRequest(
      '/api/deploy',
      { siteId: 'site-one', deploymentId, files: [] },
      'POST',
      'wrong-key',
    ),
    harness.env,
    harness.context,
  )
  assert.equal(unauthorized.status, 401)

  const foreignHost = await worker.fetch(
    new Request('https://attacker.example/api/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify({ siteId: 'site-one', deploymentId, files: [] }),
    }),
    harness.env,
    harness.context,
  )
  assert.equal(foreignHost.status, 404)

  const reserved = await upload(harness, 'api', deploymentId, [
    ['index.html', '<h1>no</h1>', 'text/html'],
  ])
  assert.equal(reserved.status, 400)

  const oversized = await worker.fetch(
    new Request(`https://${SITE_DOMAIN}/api/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(10 * 1024 * 1024),
        'X-API-Key': API_KEY,
      },
      body: '{}',
    }),
    harness.env,
    harness.context,
  )
  assert.equal(oversized.status, 413)
})

test('rejects traversal, hidden files, source maps, duplicate paths, and bad content types', async () => {
  const invalidPaths = [
    '../secret',
    'assets/../secret',
    '.env',
    'assets/.private/key',
    'assets/app.js.map',
    '/index.html',
    'assets\\app.js',
    'assets//app.js',
    'assets/app%2Fsecret.js',
    'assets/query?.js',
    'assets/hash#.js',
    'assets/control\u0001.js',
  ]

  for (const [index, path] of invalidPaths.entries()) {
    const harness = createHarness()
    const response = await upload(harness, 'site-one', `${index}`.padStart(32, 'a'), [
      [path, 'content', 'text/plain'],
    ])
    assert.equal(response.status, 400, path)
  }

  const duplicateHarness = createHarness()
  const duplicate = await worker.fetch(
    apiRequest('/api/deploy', {
      siteId: 'site-one',
      deploymentId: 'b'.repeat(32),
      files: [
        { path: 'index.html', content: encode('one'), contentType: 'text/html' },
        { path: 'index.html', content: encode('two'), contentType: 'text/html' },
      ],
    }),
    duplicateHarness.env,
    duplicateHarness.context,
  )
  assert.equal(duplicate.status, 400)

  const contentTypeHarness = createHarness()
  const badContentType = await upload(
    contentTypeHarness,
    'site-one',
    'c'.repeat(32),
    [['index.html', 'content', 'text/html\r\nX-Test: injected']],
  )
  assert.equal(badContentType.status, 400)
})

test('keeps the active deployment unchanged until finalize and removes the prior version afterward', async () => {
  const harness = createHarness()
  const siteId = 'site-one'
  const firstDeployment = '1'.repeat(32)
  const secondDeployment = '2'.repeat(32)

  assert.equal(
    (
      await upload(harness, siteId, firstDeployment, [
        ['index.html', '<h1>first</h1>', 'text/html'],
        ['assets/old-deadbeef.js', 'old', 'application/javascript'],
      ])
    ).status,
    200,
  )
  assert.equal((await getSite(harness, siteId)).status, 404)

  assert.equal((await finalize(harness, siteId, firstDeployment)).status, 200)
  assert.equal(await (await getSite(harness, siteId)).text(), '<h1>first</h1>')
  const mutateActive = await upload(harness, siteId, firstDeployment, [
    ['index.html', '<h1>mutated</h1>', 'text/html'],
  ])
  assert.equal(mutateActive.status, 409)
  assert.equal(await (await getSite(harness, siteId)).text(), '<h1>first</h1>')

  assert.equal(
    (
      await upload(harness, siteId, secondDeployment, [
        ['index.html', '<h1>second</h1>', 'text/html'],
      ])
    ).status,
    200,
  )
  assert.equal(await (await getSite(harness, siteId)).text(), '<h1>first</h1>')

  assert.equal((await finalize(harness, siteId, secondDeployment)).status, 200)
  assert.equal(await (await getSite(harness, siteId)).text(), '<h1>second</h1>')

  await Promise.all(harness.pending)
  assert.equal(
    [...harness.bucket.objects.keys()].some((key) =>
      key.includes(`/deployments/${firstDeployment}/`),
    ),
    false,
  )
  assert.equal(
    (
      await getSite(
        harness,
        siteId,
        '/assets/old-deadbeef.js',
        'application/javascript',
      )
    ).status,
    404,
  )
})

test('serves decoded paths, stored MIME metadata, ETags, HEAD, and conservative cache headers', async () => {
  const harness = createHarness()
  const siteId = 'site-two'
  const deploymentId = '3'.repeat(32)

  const response = await upload(harness, siteId, deploymentId, [
    ['index.html', '<h1>home</h1>', 'text/html'],
    ['hello world.txt', 'hello', 'text/plain'],
    ['assets/module.wasm', 'wasm', 'application/wasm'],
    ['assets/app-deadbeef.js', 'hashed', 'application/javascript'],
    ['assets/app.js', 'stable', 'application/javascript'],
  ])
  assert.equal(response.status, 200)
  assert.equal((await finalize(harness, siteId, deploymentId)).status, 200)

  const spaced = await getSite(harness, siteId, '/hello%20world.txt', 'text/plain')
  assert.equal(spaced.status, 200)
  assert.equal(await spaced.text(), 'hello')
  assert.equal(spaced.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.ok(spaced.headers.get('etag'))

  const wasm = await getSite(
    harness,
    siteId,
    '/assets/module.wasm',
    'application/wasm',
  )
  assert.equal(wasm.headers.get('content-type'), 'application/wasm')
  assert.equal(wasm.headers.get('cache-control'), 'no-cache')

  const hashed = await getSite(
    harness,
    siteId,
    '/assets/app-deadbeef.js',
    'application/javascript',
  )
  assert.equal(
    hashed.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  )

  const stable = await getSite(
    harness,
    siteId,
    '/assets/app.js',
    'application/javascript',
  )
  assert.equal(stable.headers.get('cache-control'), 'no-cache')

  const head = await worker.fetch(
    new Request(`https://${siteId}.${SITE_DOMAIN}/index.html`, {
      method: 'HEAD',
    }),
    harness.env,
    harness.context,
  )
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
})

test('does not expose storage error details', async () => {
  const harness = createHarness()
  harness.bucket.failNextPut = true

  const response = await upload(harness, 'site-three', '4'.repeat(32), [
    ['index.html', '<h1>content</h1>', 'text/html'],
  ])
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes('private storage detail'), false)
})

test('validates domains and canonical path helpers', () => {
  assert.equal(__testing__.normalizeSiteDomain('preview.example.com'), SITE_DOMAIN)
  assert.equal(__testing__.normalizeSiteDomain('Preview.example.com'), null)
  assert.equal(__testing__.normalizeSiteDomain('https://preview.example.com'), null)
  assert.equal(__testing__.decodeRequestPath('/docs/'), 'docs/index.html')
  assert.equal(__testing__.decodeRequestPath('/%E0%A4%A'), null)
  assert.equal(__testing__.isValidSiteId('www'), false)
})
