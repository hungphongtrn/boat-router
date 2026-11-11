import test from 'node:test';
import assert from 'node:assert/strict';
import {Fleet} from '../src/fleet.mjs';
import {hash} from '../src/setup.mjs';
import {Storage} from './helpers.mjs';
import {leaseBase} from '../src/router/lease-base.mjs';
import {snapshotBootstrap} from '../src/snapshot-bootstrap.mjs';

test('lease claims pin a configured base and retain it across configuration changes', async () => {
  const token='a'.repeat(40), id='00000000-0000-4000-8000-000000000001', storage=new Storage();
  const clients={lease: { enabled: true, seededBase: true,project:'project-a',maxActive:6,startsPerDay:60,ttlSeconds:900,tokenHash:await hash(token)}};
  const env={ENABLED:'true',PLUGIN_ROUTER:'true',BOAT_WALLET: 'example-account',BOAT_PROVIDER_WALLET:'team_test',ROUTER_PROJECTS:'project-a',EXTERNAL_LEASE_CLIENTS:JSON.stringify(clients),LEASE_BASE_SNAPSHOT_NAME:'lease-ci-20261111-1234abcd',LEASE_BASE_SNAPSHOT_ID:'snapshot-id',LEASE_BASE_MANIFEST_SHA256:'b'.repeat(64),LEASE_BASE_PROFILE_SHA256:'c'.repeat(64)};
  const fleet=new Fleet({storage,waitUntil(){}},env);let selection;
  fleet.external.claim=async (_c,_i,_s,_iso,_repo,_tick,selected)=>{selection=selected;return {machineId:'bx_23456789',expiresAt:Date.now()+60000,isolation:'external-v2'}};
  const send=()=>fleet.fetch(new Request('https://fleet/router/lease/claim',{method:'POST',headers:{'X-Boat-CI-Enabled':'true','X-Lease-Client':'lease',Authorization:`Bearer ${token}`},body:JSON.stringify({id,size:'default',isolation:'external-v2'})}));
  fleet.env.LEASE_BASE_SNAPSHOT_ID='';assert.equal((await send()).status,503);
  fleet.env.LEASE_BASE_SNAPSHOT_ID='snapshot-id';assert.equal((await send()).status,200);assert.equal(selection.routerSnapshot.snapshotId,'snapshot-id');
  await storage.put(`external-lease:lease:${id}`,{id,client:'lease',size:'default',...selection,state:'active'});
  fleet.env.LEASE_BASE_SNAPSHOT_ID='new-snapshot';assert.equal((await send()).status,200);assert.equal(selection.routerSnapshot.snapshotId,'snapshot-id');
});

test('lease base rejects incomplete or inconsistent identity inputs', async () => {
  const env={LEASE_BASE_SNAPSHOT_NAME:'lease-ci-20261111-1234abcd',LEASE_BASE_SNAPSHOT_ID:'id',LEASE_BASE_MANIFEST_SHA256:'b'.repeat(64),LEASE_BASE_PROFILE_SHA256:'c'.repeat(64)};
  const first=await leaseBase(env);assert.equal(first.base,'lease-v1');assert.match(first.baseId,/^[a-f0-9]{64}$/);
  assert.notEqual((await leaseBase({...env,LEASE_BASE_SNAPSHOT_ID:'other'})).baseId,first.baseId);
  assert.equal(await leaseBase({...env,LEASE_BASE_PROFILE_SHA256:'bad'}),null);
});

test('lease snapshot boot checks the toolchain profile fingerprint', () => {
  const script=snapshotBootstrap('b'.repeat(64),{reusable:true,leaseProfileSha256:'c'.repeat(64)});
  assert.ok(script.includes('/opt/boat-toolchain/.lease-profile-sha256'));
  assert.ok(script.includes('c'.repeat(64)));
  assert.throws(()=>snapshotBootstrap('b'.repeat(64),{leaseProfileSha256:'invalid'}));
});

test('a released starting lease closes even if its selected snapshot is no longer available', async () => {
  const {ExternalLeaseStarts} = await import('../src/router/external-leases.mjs');
  const storage = new Storage(), id = '00000000-0000-4000-8000-000000000001';
  const env = {LEASE_BASE_SNAPSHOT_NAME:'lease-ci-20261111-1234abcd',LEASE_BASE_SNAPSHOT_ID:'snapshot-id',LEASE_BASE_MANIFEST_SHA256:'b'.repeat(64),LEASE_BASE_PROFILE_SHA256:'c'.repeat(64)};
  const selection = await leaseBase(env);
  await storage.put(`external-lease:lease:${id}`, {id, client:'lease', state:'starting', project:'project-a', size:'default', pool:'p', claimKey:'claim', isolation:'external-v2', account:'primary', expiresAt:9999, releaseRequested:true, ...selection});
  let abandoned = false;
  const ledger = {claim:async()=>({status:'pending'}), abandon:async(project,key)=>{assert.equal(project,'project-a');assert.equal(key,'claim');abandoned=true}};
  const api = {forIdentity:async()=>({request:async()=>({snapshot:{status:'missing'}})})};
  assert.equal(await new ExternalLeaseStarts(storage,ledger,api,()=>1000).start('lease',id,'project-a','default','p',{},7200),false);
  assert.equal(abandoned,true);
  assert.equal((await storage.get(`external-lease:lease:${id}`)).state,'closed');
});
