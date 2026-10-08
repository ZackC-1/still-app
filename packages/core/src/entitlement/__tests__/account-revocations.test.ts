import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import vectors from "../../../../../tests/access-proof/vectors.json";
import { verifyAccessProof, type AccessTrust } from "../access-proof.js";
import { EMPTY_ACCESS_RECORD, mutateAccessRecord, parseAccessCacheRecord } from "../access-record.js";
const trust: AccessTrust = {environment:"sandbox",keys:[{kid:"synthetic-access",purpose:"access",environment:"sandbox",publicKeyHex:vectors.publicKeyHex}]};
async function paid() {
  const result=await verifyAccessProof(vectors.vectors.find(v=>v.name==="paid-account")!.envelope,trust);
  if(result.status!=="verified")throw new Error("Invalid synthetic vector");return result.proof;
}
describe("holder-scoped canonical account removals",()=>{
  it("holds a known revoked account proof during observe and install",async()=>{
    const p=await paid();
    let record=(await mutateAccessRecord(EMPTY_ACCESS_RECORD,{kind:"account",accountId:vectors.account},trust)).record;
    const install={kind:"install" as const,proof:p,generation:record.generation,issuerNow:vectors.verifiedAt,wall:1000,localRights:new Set<string>()};
    record=(await mutateAccessRecord(record,install,trust)).record;
    const scoped=parseAccessCacheRecord({...record,accountRevocations:[{holder:p.claims.holder,right:p.claims.right,revision:p.claims.ownership_revision}]});
    const observed=await mutateAccessRecord(scoped,{kind:"observe",observation:{wall:1001}},trust);
    expect(observed.evidence[0]?.revoked).toBe(true);
    expect(observed.record.rights[0]?.clock?.revoked).toBe(true);
    await expect(mutateAccessRecord(scoped,install,trust)).rejects.toThrow();
  });
  it("accepts old records, preserves unknown members and rejects malformed scoped tombstones",()=>{
    expect(parseAccessCacheRecord(EMPTY_ACCESS_RECORD)).toEqual(EMPTY_ACCESS_RECORD);
    expect(parseAccessCacheRecord({...EMPTY_ACCESS_RECORD,future:{kept:true},accountRevocations:[]})).toMatchObject({future:{kept:true}});
    for(const bad of [[{holder:vectors.account,right:vectors.localRight,revision:true}],[{holder:vectors.account,right:vectors.localRight,revision:1,extra:true}],Array(65).fill({holder:vectors.account,right:vectors.localRight,revision:1})])expect(()=>parseAccessCacheRecord({...EMPTY_ACCESS_RECORD,accountRevocations:bad})).toThrow();
  });
});

it("preserves independent Apple local scope when installing an account proof with the same right UUID",async()=>{
  const localResult=await verifyAccessProof(vectors.vectors.find(v=>v.name==="paid-apple-local")!.envelope,trust);
  if(localResult.status!=="verified")throw new Error("Invalid local vector");
  const accountEnvelope=JSON.parse(vectors.vectors.find(v=>v.name==="paid-account")!.envelope);
  const claims=JSON.parse(Buffer.from(accountEnvelope.payload,"base64url").toString());
  claims.right=localResult.proof.claims.right;
  const payload=JSON.stringify(claims);
  const key=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.alloc(32,7)]),format:"der",type:"pkcs8"});
  const signed={...accountEnvelope,payload:Buffer.from(payload).toString("base64url"),signature:sign(null,Buffer.from("still-access-proof-v1\n"+payload),key).toString("base64url")};
  const account=await verifyAccessProof(JSON.stringify(signed),trust);
  if(account.status!=="verified")throw new Error("Invalid shared-right fixture");
  let record=(await mutateAccessRecord(EMPTY_ACCESS_RECORD,{kind:"account",accountId:vectors.account},trust)).record;
  const install={kind:"install" as const,generation:record.generation,issuerNow:vectors.verifiedAt,wall:1000,localRights:new Set([localResult.proof.claims.right])};
  record=(await mutateAccessRecord(record,{...install,proof:localResult.proof},trust)).record;
  record=(await mutateAccessRecord(record,{...install,proof:account.proof},trust)).record;
  expect(record.rights).toHaveLength(2);
  const scoped=parseAccessCacheRecord({...record,accountRevocations:[{holder:claims.holder,right:claims.right,revision:claims.ownership_revision}]});
  const observed=await mutateAccessRecord(scoped,{kind:"observe",observation:{wall:1001}},trust);
  expect(observed.evidence.find(e=>e.proof.claims.kind==="paid_account")?.revoked).toBe(true);
  expect(observed.evidence.find(e=>e.proof.claims.kind==="paid_apple_local")?.revoked).toBe(false);
  await expect(mutateAccessRecord(scoped,{...install,proof:localResult.proof},trust)).resolves.toMatchObject({record:{rights:expect.any(Array)}});
});
