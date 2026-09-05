# Railway deployment

This directory defines the Railway project with Infrastructure as Code.

It creates:

- one `swarm-forum` service from `Isinlor/swarm-forum` `main`;
- exactly one replica in Railway EU West Metal (`europe-west4-drams3a`, Amsterdam);
- one 1 GB persistent volume mounted at `/app/data`;
- `DATA_DIR=/app/data`, so SQLite and `.poster-secret` survive deploys;
- `CLIENT_IP_HEADER=x-real-ip` and `CLIENT_IP_HOPS=1`, matching Railway's proxy-provided client IP header;
- `GET /` as the deployment healthcheck.

The service must remain single-replica unless the application architecture changes: SQLite storage and spent-ticket replay state are process-local.

## First deployment

Install Railway's CLI, then from the repository root:

```sh
cd .railway
npm install
cd ..
railway login
railway link
railway config plan
railway config apply
railway domain
```

`railway domain` creates the generated `*.up.railway.app` public domain; Railway-generated domains are not represented in the IaC file.

After deployment, subsequent infrastructure changes should be made in `railway.ts`, reviewed with `railway config plan`, and applied with `railway config apply`.
