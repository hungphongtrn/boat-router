import account from './peek/account.json' with { type: 'json' };
import project from './peek/project.json' with { type: 'json' };
import clients from './peek/clients.json' with { type: 'json' };
import example from '../examples/account.json' with { type: 'json' };
import secondary from '../examples/account-secondary.json' with { type: 'json' };
import projectA from '../examples/project.json' with { type: 'json' };
import projectB from '../examples/project-b.json' with { type: 'json' };
import projectC from '../examples/project-c.json' with { type: 'json' };
// Every account the router may use. The Worker env picks one: this deployment's
// `wrangler.jsonc` sets `BOAT_WALLET=peek` and `ROUTER_PROJECTS=peek`, so the
// example accounts and projects below are fixtures the test suite runs on and are
// never selected by the deployed Worker.
export const accounts = [account, example, secondary];
// Lease clients installed with the Worker. A token is never here: it arrives as
// the EXTERNAL_LEASE_TOKEN_HASHES secret, and EXTERNAL_LEASE_CLIENTS overrides
// or adds a client on top of this file.
export const leaseClients = clients;
export const projects = [
  { config: project },
  { config: projectA },
  { config: projectB, optIn: true },
  { config: projectC, optIn: true },
];
