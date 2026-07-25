interface Env {
  BYTRO_PREVIEW_BUCKET: R2Bucket
  UPLOAD_API_KEY: string
  SITE_DOMAIN: string
}

interface FilePayload {
  path: string
  content: string
  contentType: string
}

interface UploadRequestBody {
  siteId: string
  deploymentId: string
  files: FilePayload[]
}

interface FinalizeRequestBody {
  siteId: string
  deploymentId: string
}

interface ActiveDeployment {
  deploymentId: string
  activatedAt: string
  fileCount: number
  totalBytes: number
}

type CorsPolicy = 'api' | 'public'

const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/
const DEPLOYMENT_ID_RE = /^[a-f0-9]{32}$/
const CONTENT_TYPE_RE =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*charset=[A-Za-z0-9._-]+)?$/
const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'mail'])

const MAX_FILES_PER_REQUEST = 50
const MAX_FILES_PER_DEPLOYMENT = 500
const MAX_FILE_DECODED_BYTES = 5 * 1024 * 1024
const MAX_FILE_ENCODED_LENGTH = 7 * 1024 * 1024
const MAX_REQUEST_ENCODED_LENGTH = 8 * 1024 * 1024
const MAX_REQUEST_BODY_BYTES = 9 * 1024 * 1024
const MAX_DEPLOYMENT_BYTES = 50 * 1024 * 1024
const MAX_CONTENT_TYPE_LENGTH = 128

const ALLOWED_API_ORIGINS = new Set([
  'tauri://localhost',
  'https://tauri.localhost',
  'http://tauri.localhost',
  'http://localhost:1420',
  'https://localhost',
])

function isValidSiteId(siteId: string): boolean {
  return SITE_ID_RE.test(siteId) && !RESERVED_SUBDOMAINS.has(siteId)
}

function isValidDeploymentId(deploymentId: string): boolean {
  return DEPLOYMENT_ID_RE.test(deploymentId)
}

function validateFilePath(raw: string): string | null {
  if (!raw || raw.length > 512) return null
  if (raw.startsWith('/') || raw.endsWith('/')) return null
  if (
    raw.includes('\\') ||
    raw.includes('//') ||
    raw.includes('%') ||
    raw.includes('?') ||
    raw.includes('#') ||
    [...raw].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    return null
  }

  const segments = raw.split('/')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.startsWith('.'),
    )
  ) {
    return null
  }

  if (raw.toLowerCase().endsWith('.map')) return null
  return raw
}

function decodeRequestPath(pathname: string): string | null {
  const encodedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname
  let decoded: string
  try {
    decoded = decodeURIComponent(encodedPath)
  } catch {
    return null
  }

  if (!decoded) return 'index.html'
  if (decoded.endsWith('/')) decoded += 'index.html'
  return validateFilePath(decoded)
}

function isFilePayload(value: unknown): value is FilePayload {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<FilePayload>
  return (
    typeof file.path === 'string' &&
    typeof file.content === 'string' &&
    typeof file.contentType === 'string'
  )
}

function isValidContentType(contentType: string): boolean {
  return (
    contentType.length > 0 &&
    contentType.length <= MAX_CONTENT_TYPE_LENGTH &&
    CONTENT_TYPE_RE.test(contentType)
  )
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index)
  }
  return bytes.buffer
}

function base64DecodedLength(base64: string): number | null {
  if (base64.length % 4 !== 0) return null

  let padding = 0
  if (base64.endsWith('==')) padding = 2
  else if (base64.endsWith('=')) padding = 1

  const contentLength = base64.length - padding
  for (let index = 0; index < contentLength; index += 1) {
    const code = base64.charCodeAt(index)
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    if (!valid) return null
  }
  for (let index = contentLength; index < base64.length; index += 1) {
    if (base64.charCodeAt(index) !== 61) return null
  }

  return (base64.length / 4) * 3 - padding
}

function getContentType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    map: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    wasm: 'application/wasm',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    ogv: 'video/ogg',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
    pdf: 'application/pdf',
    csv: 'text/csv; charset=utf-8',
    webmanifest: 'application/manifest+json; charset=utf-8',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
  }
  return types[extension] ?? 'application/octet-stream'
}

function isContentHashedAsset(path: string): boolean {
  if (!path.startsWith('assets/')) return false
  const filename = path.split('/').pop() ?? ''
  return /(?:^|[-.])[a-f0-9]{8,}\.[^.]+$/i.test(filename)
}

function normalizeSiteDomain(raw: string): string | null {
  if (!raw || raw !== raw.trim() || raw !== raw.toLowerCase()) return null
  if (raw.length > 253 || raw.includes(':') || raw.includes('/') || raw.endsWith('.')) {
    return null
  }

  const labels = raw.split('.')
  if (labels.length < 2) return null
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return null
  }
  return raw
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  )
}

function corsHeaders(request: Request, policy: CorsPolicy): Record<string, string> {
  if (policy === 'public') {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    Vary: 'Origin',
  }
  const origin = request.headers.get('Origin')
  if (origin && ALLOWED_API_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function jsonResponse(
  data: unknown,
  status: number,
  request: Request,
  policy: CorsPolicy = 'api',
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(request, policy),
    },
  })
}

function errorResponse(
  message: string,
  status: number,
  request: Request,
  policy: CorsPolicy = 'api',
): Response {
  return jsonResponse({ success: false, error: message }, status, request, policy)
}

async function readLimitedJson(
  request: Request,
): Promise<
  | { value: unknown }
  | { error: 'invalid' | 'too-large' }
> {
  const declaredLength = request.headers.get('Content-Length')
  if (declaredLength) {
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length < 0) {
      return { error: 'invalid' }
    }
    if (length > MAX_REQUEST_BODY_BYTES) {
      return { error: 'too-large' }
    }
  }
  if (!request.body) return { error: 'invalid' }

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const reader = request.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel()
        return { error: 'too-large' }
      }
      chunks.push(value)
    }
  } catch {
    return { error: 'invalid' }
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes)
    return { value: JSON.parse(text) }
  } catch {
    return { error: 'invalid' }
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < maxLength; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

function validateApiKey(request: Request, env: Env): boolean {
  const configuredKey = env.UPLOAD_API_KEY
  const providedKey = request.headers.get('X-API-Key')
  if (!configuredKey || !providedKey) return false
  return constantTimeEqual(providedKey, configuredKey)
}

function deploymentPrefix(siteId: string, deploymentId: string): string {
  return `sites/${siteId}/deployments/${deploymentId}/`
}

function activePointerKey(siteId: string): string {
  return `sites/${siteId}/active.json`
}

async function listAllObjects(
  bucket: R2Bucket,
  prefix: string,
): Promise<R2Object[]> {
  const objects: R2Object[] = []
  let cursor: string | undefined
  do {
    const listed = await bucket.list({ prefix, cursor })
    objects.push(...listed.objects)
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  return objects
}

async function readActiveDeployment(
  env: Env,
  siteId: string,
): Promise<ActiveDeployment | null> {
  const object = await env.BYTRO_PREVIEW_BUCKET.get(activePointerKey(siteId))
  if (!object) return null

  let value: unknown
  try {
    value = JSON.parse(await object.text())
  } catch {
    throw new Error('invalid active deployment pointer')
  }

  if (!value || typeof value !== 'object') {
    throw new Error('invalid active deployment pointer')
  }
  const pointer = value as Partial<ActiveDeployment>
  if (
    typeof pointer.deploymentId !== 'string' ||
    !isValidDeploymentId(pointer.deploymentId) ||
    typeof pointer.activatedAt !== 'string' ||
    typeof pointer.fileCount !== 'number' ||
    typeof pointer.totalBytes !== 'number'
  ) {
    throw new Error('invalid active deployment pointer')
  }
  return pointer as ActiveDeployment
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deletedCount = 0
  while (true) {
    // Restart from the beginning after each delete. R2 cursors describe the
    // pre-delete listing and can otherwise skip keys as the prefix shrinks.
    const listed = await bucket.list({ prefix })
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((object) => object.key))
      deletedCount += listed.objects.length
    }
    if (listed.objects.length === 0 || !listed.truncated) break
  }
  return deletedCount
}

function validateUploadBody(
  body: unknown,
  request: Request,
): { body: UploadRequestBody } | { error: Response } {
  if (!body || typeof body !== 'object') {
    return { error: errorResponse('Invalid request body', 400, request) }
  }

  const { siteId, deploymentId, files } = body as Partial<UploadRequestBody>
  if (typeof siteId !== 'string' || !isValidSiteId(siteId)) {
    return { error: errorResponse('Missing or invalid siteId', 400, request) }
  }
  if (
    typeof deploymentId !== 'string' ||
    !isValidDeploymentId(deploymentId)
  ) {
    return {
      error: errorResponse('Missing or invalid deploymentId', 400, request),
    }
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { error: errorResponse('Missing or invalid files array', 400, request) }
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return {
      error: errorResponse(
        `Too many files: max ${MAX_FILES_PER_REQUEST} per request`,
        400,
        request,
      ),
    }
  }
  if (!files.every(isFilePayload)) {
    return {
      error: errorResponse(
        'Each file must include string path, content, and contentType fields',
        400,
        request,
      ),
    }
  }

  const seenPaths = new Set<string>()
  let totalEncodedLength = 0
  for (const file of files) {
    const safePath = validateFilePath(file.path)
    if (!safePath) {
      return { error: errorResponse('Invalid file path', 400, request) }
    }
    if (seenPaths.has(safePath)) {
      return { error: errorResponse('Duplicate file path', 400, request) }
    }
    seenPaths.add(safePath)

    if (!isValidContentType(file.contentType)) {
      return { error: errorResponse('Invalid content type', 400, request) }
    }
    if (file.content.length > MAX_FILE_ENCODED_LENGTH) {
      return { error: errorResponse('File is too large', 413, request) }
    }
    totalEncodedLength += file.content.length
    if (totalEncodedLength > MAX_REQUEST_ENCODED_LENGTH) {
      return { error: errorResponse('Upload payload is too large', 413, request) }
    }
  }

  return {
    body: {
      siteId,
      deploymentId,
      files,
    },
  }
}

async function handleUpload(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!validateApiKey(request, env)) {
    return errorResponse('Unauthorized', 401, request)
  }

  const parsedBody = await readLimitedJson(request)
  if ('error' in parsedBody) {
    if (parsedBody.error === 'too-large') {
      return errorResponse('Upload payload is too large', 413, request)
    }
    return errorResponse('Invalid JSON body', 400, request)
  }

  const validated = validateUploadBody(parsedBody.value, request)
  if ('error' in validated) return validated.error
  const { siteId, deploymentId, files } = validated.body
  const prefix = deploymentPrefix(siteId, deploymentId)

  let existingObjects: R2Object[]
  let active: ActiveDeployment | null
  try {
    ;[existingObjects, active] = await Promise.all([
      listAllObjects(env.BYTRO_PREVIEW_BUCKET, prefix),
      readActiveDeployment(env, siteId),
    ])
  } catch {
    return errorResponse('Preview storage is unavailable', 503, request)
  }
  if (active?.deploymentId === deploymentId) {
    return errorResponse('Active deployments are immutable', 409, request)
  }

  const existingByPath = new Map(
    existingObjects.map((object) => [
      object.key.slice(prefix.length),
      object.size,
    ]),
  )
  let projectedFileCount = existingByPath.size
  let projectedBytes = existingObjects.reduce(
    (total, object) => total + object.size,
    0,
  )

  for (const file of files) {
    const decodedLength = base64DecodedLength(file.content)
    if (decodedLength === null) {
      return errorResponse('Invalid base64 file content', 400, request)
    }
    if (decodedLength > MAX_FILE_DECODED_BYTES) {
      return errorResponse('File is too large', 413, request)
    }

    const previousSize = existingByPath.get(file.path)
    if (previousSize === undefined) {
      projectedFileCount += 1
    } else {
      projectedBytes -= previousSize
    }
    projectedBytes += decodedLength
    existingByPath.set(file.path, decodedLength)
  }

  if (projectedFileCount > MAX_FILES_PER_DEPLOYMENT) {
    return errorResponse('Deployment contains too many files', 413, request)
  }
  if (projectedBytes > MAX_DEPLOYMENT_BYTES) {
    return errorResponse('Deployment is too large', 413, request)
  }

  try {
    for (const file of files) {
      const bytes = base64ToArrayBuffer(file.content)
      await env.BYTRO_PREVIEW_BUCKET.put(`${prefix}${file.path}`, bytes, {
        httpMetadata: {
          contentType: getContentType(file.path),
        },
      })
    }
  } catch {
    return errorResponse('Preview storage is unavailable', 503, request)
  }

  return jsonResponse(
    {
      success: true,
      siteId,
      deploymentId,
      filesUploaded: files.length,
    },
    200,
    request,
  )
}

async function handleFinalize(
  request: Request,
  env: Env,
  context: ExecutionContext,
  siteDomain: string,
): Promise<Response> {
  if (!validateApiKey(request, env)) {
    return errorResponse('Unauthorized', 401, request)
  }

  const parsedBody = await readLimitedJson(request)
  if ('error' in parsedBody) {
    if (parsedBody.error === 'too-large') {
      return errorResponse('Upload payload is too large', 413, request)
    }
    return errorResponse('Invalid JSON body', 400, request)
  }
  const body = parsedBody.value
  if (!body || typeof body !== 'object') {
    return errorResponse('Invalid request body', 400, request)
  }

  const { siteId, deploymentId } = body as Partial<FinalizeRequestBody>
  if (typeof siteId !== 'string' || !isValidSiteId(siteId)) {
    return errorResponse('Missing or invalid siteId', 400, request)
  }
  if (
    typeof deploymentId !== 'string' ||
    !isValidDeploymentId(deploymentId)
  ) {
    return errorResponse('Missing or invalid deploymentId', 400, request)
  }

  const prefix = deploymentPrefix(siteId, deploymentId)
  let objects: R2Object[]
  let previous: ActiveDeployment | null
  try {
    ;[objects, previous] = await Promise.all([
      listAllObjects(env.BYTRO_PREVIEW_BUCKET, prefix),
      readActiveDeployment(env, siteId),
    ])
  } catch {
    return errorResponse('Preview storage is unavailable', 503, request)
  }

  const totalBytes = objects.reduce((total, object) => total + object.size, 0)
  const hasIndex = objects.some(
    (object) => object.key === `${prefix}index.html`,
  )
  if (!hasIndex) {
    return errorResponse('Deployment must include index.html', 400, request)
  }
  if (objects.length > MAX_FILES_PER_DEPLOYMENT || totalBytes > MAX_DEPLOYMENT_BYTES) {
    return errorResponse('Deployment exceeds configured limits', 413, request)
  }

  const pointer: ActiveDeployment = {
    deploymentId,
    activatedAt: new Date().toISOString(),
    fileCount: objects.length,
    totalBytes,
  }

  try {
    await env.BYTRO_PREVIEW_BUCKET.put(
      activePointerKey(siteId),
      JSON.stringify(pointer),
      {
        httpMetadata: {
          contentType: 'application/json; charset=utf-8',
          cacheControl: 'no-store',
        },
      },
    )
  } catch {
    return errorResponse('Preview storage is unavailable', 503, request)
  }

  if (previous && previous.deploymentId !== deploymentId) {
    context.waitUntil(
      deletePrefix(
        env.BYTRO_PREVIEW_BUCKET,
        deploymentPrefix(siteId, previous.deploymentId),
      ).then(
        () => undefined,
        () => undefined,
      ),
    )
  }

  return jsonResponse(
    {
      success: true,
      siteId,
      deploymentId,
      url: `https://${siteId}.${siteDomain}`,
      filesPublished: objects.length,
    },
    200,
    request,
  )
}

async function handleDeleteSite(
  siteId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  if (!validateApiKey(request, env)) {
    return errorResponse('Unauthorized', 401, request)
  }
  if (!isValidSiteId(siteId)) {
    return errorResponse('Missing or invalid siteId', 400, request)
  }

  let deletedCount: number
  try {
    deletedCount = await deletePrefix(
      env.BYTRO_PREVIEW_BUCKET,
      `sites/${siteId}/`,
    )
  } catch {
    return errorResponse('Preview storage is unavailable', 503, request)
  }

  return jsonResponse(
    {
      success: true,
      siteId,
      filesDeleted: deletedCount,
    },
    200,
    request,
  )
}

function staticHeaders(
  object: R2ObjectBody,
  filePath: string,
): Headers {
  const headers = new Headers({
    'Cache-Control': isContentHashedAsset(filePath)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...corsHeaders(new Request('https://static.invalid'), 'public'),
  })
  headers.set(
    'Content-Type',
    object.httpMetadata?.contentType ?? getContentType(filePath),
  )
  headers.set('ETag', object.httpEtag)
  return headers
}

async function getActiveObject(
  env: Env,
  siteId: string,
  filePath: string,
): Promise<R2ObjectBody | null> {
  const pointer = await readActiveDeployment(env, siteId)
  if (!pointer) return null
  const object = await env.BYTRO_PREVIEW_BUCKET.get(
    `${deploymentPrefix(siteId, pointer.deploymentId)}${filePath}`,
  )
  if (object) return object

  // Finalization switches the pointer before old objects are removed. If this
  // request observed the old pointer during that transition, retry once with
  // the current pointer instead of returning a transient 404.
  const current = await readActiveDeployment(env, siteId)
  if (!current || current.deploymentId === pointer.deploymentId) return null
  return env.BYTRO_PREVIEW_BUCKET.get(
    `${deploymentPrefix(siteId, current.deploymentId)}${filePath}`,
  )
}

async function handleGetSiteFile(
  siteId: string,
  pathname: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const filePath = decodeRequestPath(pathname)
  if (!filePath) {
    return errorResponse('Not found', 404, request, 'public')
  }

  let object: R2ObjectBody | null
  try {
    object = await getActiveObject(env, siteId, filePath)
  } catch {
    return errorResponse('Preview storage is unavailable', 503, request, 'public')
  }

  if (!object) {
    const acceptsHtml = request.headers.get('Accept')?.includes('text/html')
    if (!acceptsHtml || filePath === 'index.html') {
      return errorResponse('Not found', 404, request, 'public')
    }
    try {
      object = await getActiveObject(env, siteId, 'index.html')
    } catch {
      return errorResponse('Preview storage is unavailable', 503, request, 'public')
    }
    if (!object) return errorResponse('Not found', 404, request, 'public')

    const headers = staticHeaders(object, 'index.html')
    return new Response(request.method === 'HEAD' ? null : object.body, {
      status: 200,
      headers,
    })
  }

  const headers = staticHeaders(object, filePath)
  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: 200,
    headers,
  })
}

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const siteDomain = normalizeSiteDomain(env.SITE_DOMAIN)
    if (!siteDomain) {
      return errorResponse('Preview service is not configured', 503, request)
    }

    const url = new URL(request.url)
    const hostname = url.hostname.toLowerCase()
    const isSubdomainRoute =
      hostname !== siteDomain && hostname.endsWith(`.${siteDomain}`)
    const subdomain = isSubdomainRoute
      ? hostname.slice(0, -(siteDomain.length + 1))
      : null
    const isStaticRoute =
      subdomain !== null &&
      !subdomain.includes('.') &&
      isValidSiteId(subdomain)
    const isApiHost = hostname === siteDomain || isLoopbackHostname(hostname)

    if (request.method === 'OPTIONS') {
      if (isStaticRoute) {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request, 'public'),
        })
      }
      if (isApiHost) {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request, 'api'),
        })
      }
      return errorResponse('Not found', 404, request)
    }

    if (isStaticRoute && subdomain) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return errorResponse('Method not allowed', 405, request, 'public')
      }
      return handleGetSiteFile(subdomain, url.pathname, request, env)
    }

    if (!isApiHost) {
      return errorResponse('Not found', 404, request)
    }

    if (url.pathname === '/api/deploy' && request.method === 'POST') {
      return handleUpload(request, env)
    }
    if (
      url.pathname === '/api/deploy/finalize' &&
      request.method === 'POST'
    ) {
      return handleFinalize(request, env, context, siteDomain)
    }

    const deleteMatch = url.pathname.match(/^\/api\/sites\/([^/]+)$/)
    if (deleteMatch && request.method === 'DELETE') {
      return handleDeleteSite(deleteMatch[1], request, env)
    }

    return errorResponse('Not found', 404, request)
  },
}

export const __testing__ = {
  decodeRequestPath,
  getContentType,
  isContentHashedAsset,
  isValidSiteId,
  normalizeSiteDomain,
  validateFilePath,
}
