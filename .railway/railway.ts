import { defineRailway, github, project, service, volume } from "railway/iac";

const REGION = "europe-west4-drams3a";

export default defineRailway(() => {
  // SQLite and proof-of-work replay state are process-local, so this service
  // deliberately stays on one replica with its data on one persistent volume.
  const data = volume("data", {
    region: REGION,
    sizeMB: 1024,
  });

  const web = service("swarm-forum", {
    source: github("Isinlor/swarm-forum", { branch: "main" }),
    start: "npm start",
    healthcheck: "/",
    healthcheckTimeout: 30,
    replicas: { [REGION]: 1 },
    volumeMounts: {
      "/app/data": data,
    },
    env: {
      DATA_DIR: "/app/data",
      CLIENT_IP_HEADER: "x-real-ip",
      CLIENT_IP_HOPS: "1",
    },
  });

  return project("swarm-forum", {
    resources: [web, data],
  });
});
