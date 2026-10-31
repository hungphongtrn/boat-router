import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lightResetCommand, parseLightResetResult } from '../src/router/light-reset.mjs';

for (const [target, step] of [['docker','docker prune'], ['find','clean work dir'], ['tar','prepare runner'], ['df','sanity checks']]) {
  test(`reports ${step} output and exit status`, () => {
    const dir=mkdtempSync(`${tmpdir()}/reset-step-probe-`), bin=`${dir}/bin`; mkdirSync(bin);
    const stub=(name,body)=>writeFileSync(`${bin}/${name}`,`#!/bin/bash\n${body}\n`,{mode:0o755});
    for(const name of ['pkill','find','mkdir','sha256sum','tar','chown','docker']) stub(name,'exit 0');
    stub('pgrep','exit 1');
    stub('df',"printf 'Filesystem blocks used available\\nfixture 1 1 9999999\\n'");
    stub(target,'echo "token=secret-value failure detail" >&2; exit 7');
    const script=Buffer.from(lightResetCommand(1).match(/[A-Za-z0-9+/]{80,}={0,2}/)[0],'base64').toString();
    const result=spawnSync('/bin/bash',['-c',script],{env:{PATH:`${bin}:/usr/bin:/bin`},encoding:'utf8'});
    assert.equal(result.status,7);
    const detail=parseLightResetResult({exitCode:result.status,stdout:result.stdout,stderr:result.stderr},1);
    assert.equal(detail.step,step); assert.equal(detail.exitCode,7);
    assert.match(detail.output,/failure detail/); assert.doesNotMatch(detail.output,/secret-value/);
  });
}

test('reports failure to list containers', () => {
  const dir=mkdtempSync(`${tmpdir()}/reset-step-probe-`), bin=`${dir}/bin`; mkdirSync(bin);
  const stub=(name,body)=>writeFileSync(`${bin}/${name}`,`#!/bin/bash\n${body}\n`,{mode:0o755});
  stub('pkill','exit 0'); stub('pgrep','exit 1');
  stub('docker','if [ "$#" -eq 2 ]; then echo "container list failed" >&2; exit 7; fi; exit 0');
  const script=Buffer.from(lightResetCommand(1).match(/[A-Za-z0-9+/]{80,}={0,2}/)[0],'base64').toString();
  const result=spawnSync('/bin/bash',['-c',script],{env:{PATH:`${bin}:/usr/bin:/bin`},encoding:'utf8'});
  assert.equal(result.status,7);
  const detail=parseLightResetResult({exitCode:result.status,stdout:result.stdout,stderr:result.stderr},1);
  assert.equal(detail.step,'docker prune'); assert.equal(detail.exitCode,7); assert.match(detail.output,/container list failed/);
});
