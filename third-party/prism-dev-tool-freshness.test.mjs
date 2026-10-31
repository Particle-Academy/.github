import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkRepo, loadAllowlist, classify} from './check.mjs';

const candidate=loadAllowlist(path.join(import.meta.dirname,'allowlist.json'));
const apps=['prism-labs','prism-sandbox'];
const previous=structuredClone(candidate);
for(const app of apps){
  delete previous.packageGrants[app].composer['nunomaduro/collision'];
  delete previous.packageGrants[app].npm['laravel-vite-plugin'];
  if(app==='prism-sandbox')delete previous.packageGrants[app].npm;
}
const times={composer:Date.parse('2026-08-04T15:19:57Z'),npm:Date.parse('2026-08-11T14:24:08.803Z')};
const errors=result=>result.findings.filter(f=>f.level==='error');

async function inspect(app,policy,now,{extra=false,unavailable=false,collision=false}={}){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'g166-freshness-'));
  const repo=path.join(scratch,app),oldIdentity=process.env.GITHUB_REPOSITORY;
  fs.mkdirSync(repo);delete process.env.GITHUB_REPOSITORY;
  try{
    fs.writeFileSync(path.join(repo,'composer.json'),JSON.stringify({name:'laravel/laravel',...(collision?{'require-dev':{'nunomaduro/collision':'^8.6'}}:{})}));
    fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({private:true,devDependencies:{'laravel-vite-plugin':'^3.2',...(extra?{react:'^19.0'}:{})}}));
    const result=await checkRepo(repo,policy,{freshness:'error',now:Date.parse(now),cacheFile:null,cacheTtlMs:0,fetcher:async eco=>{if(unavailable)throw new Error('synthetic registry unavailable');return times[eco];}});
    assert.equal(result.checked.length,1+Number(extra)+Number(collision),'The scope control must execute its nonempty manifest');
    return result;
  }finally{
    if(oldIdentity===undefined)delete process.env.GITHUB_REPOSITORY;else process.env.GITHUB_REPOSITORY=oldIdentity;
    // Only remove this test's freshly allocated, non-symlink absolute temp root.
    const absolute=path.resolve(scratch);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert(path.basename(absolute).startsWith('g166-freshness-'));assert(!fs.lstatSync(absolute).isSymbolicLink());fs.rmSync(absolute,{recursive:true,force:true});
  }
}

test('both scoped Vite grants cross the registry cliff and preserve the same expiry',async()=>{
  for(const app of apps){
    const before=await inspect(app,previous,'2026-11-13T00:00:00Z');assert.equal(errors(before).length,1);assert(errors(before).every(f=>f.kind==='stale'));
    const after=await inspect(app,candidate,'2026-11-13T00:00:00Z');assert.deepEqual(errors(after),[]);assert(after.checked.every(c=>c.via==='grant'));
  }
});
test('the dated Vite override does not transfer to an unrelated Laravel scaffold',async()=>{
  const result=await inspect('unrelated-laravel-app',candidate,'2026-11-13T00:00:00Z');assert.equal(errors(result).length,1);assert(errors(result).every(f=>f.kind==='stale'));
  for(const [eco,name] of [['composer','nunomaduro/collision'],['npm','laravel-vite-plugin']])assert.equal(classify(candidate,eco,name,'laravel/laravel').entry?.freshness,undefined);
});
test('Vite expires at its exact UTC boundary',async()=>{
  for(const app of apps){
    assert.deepEqual(errors(await inspect(app,candidate,'2027-01-30T00:00:00Z')),[]);
    const result=await inspect(app,candidate,'2027-01-30T00:00:00.001Z');assert.equal(errors(result).length,1);assert.equal(errors(result)[0].kind,'expired-override');assert.equal(errors(result)[0].name,'laravel-vite-plugin');
  }
});
test('Collision has no scoped exception and still fails without an actual approved inheritance edge',async()=>{
  for(const app of apps){assert.equal(candidate.packageGrants[app].composer['nunomaduro/collision'],undefined);const result=await inspect(app,candidate,'2026-11-13T00:00:00Z',{collision:true});assert.equal(errors(result).length,1);assert.equal(errors(result)[0].kind,'stale');assert.equal(errors(result)[0].name,'nunomaduro/collision');}
});
test('missing Vite expiry fails closed',async()=>{
  const damaged=structuredClone(candidate);delete damaged.packageGrants['prism-labs'].npm['laravel-vite-plugin'].freshness.expires;
  const result=await inspect('prism-labs',damaged,'2026-11-13T00:00:00Z');assert.equal(errors(result).length,1);assert.equal(errors(result)[0].kind,'bad-override');
});
test('scoped freshness grants cannot hide a failed lookup for another direct dependency',async()=>{
  const result=await inspect('prism-labs',candidate,'2026-11-13T00:00:00Z',{extra:true,unavailable:true});assert.equal(errors(result).length,1);assert.equal(errors(result)[0].name,'react');assert.equal(errors(result)[0].kind,'lookup-failed');
});
test('global approval entries and strict freshness policy are unchanged',()=>{
  assert.equal(candidate.policy.freshnessDays,92);assert.equal(candidate.policy.onLookupFailure,'fail');assert.equal(candidate.policy.scope,'direct-only');
  assert.deepEqual(candidate.ecosystems,previous.ecosystems);assert.deepEqual(candidate.firstParty,previous.firstParty);
  for(const app of apps){assert.equal(candidate.packageGrants[app].composer['nunomaduro/collision'],undefined);const vite=candidate.packageGrants[app].npm['laravel-vite-plugin'];assert.equal(vite.freshness.mode,'git');assert.equal(vite.freshness.expires,'2027-01-30');}
});
