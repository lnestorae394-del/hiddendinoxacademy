# Cloudflare R2 setup

1. Create a bucket named `hidden-dinox-videos`.
2. Create an Account API token restricted to that bucket with Object Read & Write.
3. Set Render variables `VIDEO_STUDIO_STORAGE=r2`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_REGION=auto`.
4. Keep Firebase Auth and Firestore environment variables unchanged.
5. Deploy staging. In Video Studio Settings / Diagnostics, apply storage CORS for the staging origin.
6. Upload a small MP4, verify analysis/render, then verify Telegram delivery.

R2 endpoint format: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
Never commit credentials.
