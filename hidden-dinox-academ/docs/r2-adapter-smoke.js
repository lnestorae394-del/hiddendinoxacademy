const { r2VideoStorage } = require('../video-studio/storage-adapter');
let calls = 0;
const fakeFetch = async () => { calls++; return new Response('<CreateMultipartUploadResult><UploadId>smoke-upload</UploadId></CreateMultipartUploadResult>', { status: 200 }); };
(async () => {
  const storage = r2VideoStorage({ env: { R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com', R2_BUCKET: 'hidden-dinox-videos', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test' }, fetchImpl: fakeFetch });
  const session = await storage.createMultipartSession({ path: 'video-studio/test/project/source.mp4', contentType: 'video/mp4' });
  const url = await storage.signUploadPart({ path: 'video-studio/test/project/source.mp4', uploadId: session.upload_id, partNumber: 1 });
  if (session.upload_id !== 'smoke-upload' || !url.includes('X-Amz-Signature=')) throw new Error('R2 multipart smoke failed');
  process.stdout.write(`R2 multipart signer smoke passed; mocked requests=${calls}\n`);
})().catch(e => { process.stderr.write(e.stack + '\n'); process.exit(1); });
