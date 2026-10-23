// Real-time collaboration (Component 3), re-homed onto @daw/shared for integration with the DAW.
// The DAW uses CollabClient; a host runs the session server.
export { CollabClient, newId, type ClientStatus, type ClientOptions } from "./client/collabClient";
export { Replica, type Dropped } from "./client/replica";
export { startSessionServer, type SessionServer, type ServerOptions } from "./server/sessionServer";
export { buildSeedProject } from "./shared/seed";
export * from "./shared/protocol";
export * from "./shared/types";
export { parseServerAddress, type ServerAddress } from "./shared/serverAddress";
