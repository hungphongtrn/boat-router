import account from '../examples/account.json' with { type: 'json' };
import secondary from '../examples/account-secondary.json' with { type: 'json' };
import project from '../examples/project.json' with { type: 'json' };
import projectB from '../examples/project-b.json' with { type: 'json' };
import projectC from '../examples/project-c.json' with { type: 'json' };
// Every account the router may use. The primary account names its second account in `secondaryAccount`;
// the pool uses both only with ACCOUNT_CUTOVER=true (see docs/setup.md).
export const accounts = [account, secondary];
// `optIn` projects run only when ROUTER_PROJECTS lists them.
export const projects = [{ config: project }, { config: projectB, optIn: true }, { config: projectC, optIn: true }];
