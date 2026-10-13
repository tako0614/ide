import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDeckRouter } from '../src/routes/decks.ts';
import { initializeDatabase } from '../src/utils/database.ts';
import type { Deck, TerminalSession, Workspace } from '../src/types.ts';
import type { TerminalRecordStatus } from '../src/terminal/tmuxAdapter.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const status = (source: TerminalRecordStatus['source'], state: TerminalRecordStatus['state'], id = ID): TerminalRecordStatus =>
  ({ terminalId: id, source, state, reason: `verified ${state}`, ...(source === 'registry' ? { entry: id + '.json' } : {}) });
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'); initializeDatabase(db); t.after(() => db.close());
  const workspace: Workspace = {id:'w',name:'work',path:'/tmp',createdAt:'now'};
  const deck: Deck = {id:'deck',name:'target',root:'/tmp',workspaceId:'w',createdAt:'now'};
  db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)').run('w','work','/tmp','/tmp','now');
  db.prepare('INSERT INTO decks (id,name,root,workspace_id,created_at) VALUES (?,?,?,?,?)').run(deck.id,deck.name,deck.root,'w','now');
  const decks = new Map([[deck.id,deck]]); const terminals = new Map<string,TerminalSession>();
  let records: TerminalRecordStatus[] = []; let recordState: TerminalRecordStatus['state'] = 'dead';
  let pruneCalls = 0; let changeOnPrune = false; const revoked:string[] = [];
  const router = createDeckRouter(db,new Map([['w',workspace]]),decks,terminals,{
    revokeTerminal: (id) => { revoked.push(id); },
    inspectNativeTerminals: () => [...records],
    inspectTerminalRecord: (id) => status('native-db',recordState,id),
    pruneNativeTerminals: (_deckId,expected) => {
      pruneCalls++;
      assert.ok(expected?.every((entry) => entry.state === 'dead'));
      records = changeOnPrune ? [status('registry','live')] : [];
      return { terminalIds: [ID] };
    },
  });
  const legacy = (id=ID) => db.prepare('INSERT INTO terminals (id,deck_id,title,created_at) VALUES (?,?,?,?)').run(id,deck.id,'private title','now');
  const native = () => db.prepare('INSERT INTO terminal_metadata VALUES (?,?,?,?,?,?,?,?)').run(ID,deck.id,'private title','now',80,24,'gen','/private/socket');
  const remove = (prune=false) => router.request('/deck'+(prune?'?pruneStale=true':''),{method:'DELETE'});
  return {db,decks,terminals,revoked,legacy,native,remove,router,setRecords:(value:TerminalRecordStatus[])=>{records=value;},
    setState:(value:TerminalRecordStatus['state'])=>{recordState=value;},calls:()=>pruneCalls,setChange:()=>{changeOnPrune=true;}};
}

test('normal delete diagnoses concrete dead registry and legacy DB blockers without pruning',async(t)=>{
  const f=fixture(t);f.setRecords([status('registry','dead')]);f.legacy();
  const response=await f.remove();assert.equal(response.status,409);const body=await response.json();
  assert.equal(body.code,'deck_delete_blocked');assert.equal(body.blockers.length,2);
  assert.equal(body.blockers[0].terminalId,ID);assert.equal(body.blockers[0].state,'dead');
  assert.equal(body.blockers[0].entry,ID+'.json');assert.equal(body.blockers[1].source,'legacy-db');
  assert.match(body.hint,/--prune-stale/);assert.equal(f.calls(),0);assert.ok(f.decks.has('deck'));
  assert.equal(JSON.stringify(body).includes('private title'),false);
});

test('explicit prune removes only dead target DB rows and registry then deletes the deck',async(t)=>{
  const f=fixture(t);f.setRecords([status('registry','dead')]);f.legacy();f.native();
  f.db.prepare('INSERT INTO terminals (id,deck_id,title,created_at) VALUES (?,?,?,?)').run('other','other-deck','untouched','now');
  const response=await f.remove(true);assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.deleted,true);assert.equal(body.pruned.length,3);assert.equal(f.calls(),1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM terminals WHERE deck_id=?').get('deck')!.n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM terminal_metadata').get()!.n,0);
  assert.ok(f.db.prepare('SELECT id FROM terminals WHERE id=?').get('other'));
  assert.equal(f.decks.has('deck'),false);assert.equal((await f.remove(true)).status,404);
});

test('live or unavailable blockers reject prune before touching even dead entries',async(t)=>{
  for(const state of ['live','unavailable'] as const) await t.test(state,async(t)=>{
    const f=fixture(t);f.setRecords([status('registry','dead'),status('registry',state,'22222222-2222-4222-8222-222222222222')]);f.legacy();
    const response=await f.remove(true);assert.equal(response.status,409);const body=await response.json();
    assert.ok(body.blockers.some((entry:{state:string})=>entry.state===state));assert.equal(f.calls(),0);
    assert.ok(f.decks.has('deck'));assert.ok(f.db.prepare('SELECT id FROM terminals WHERE id=?').get(ID));
  });
});

test('active in-memory terminal blocks deletion independently of a dead registry diagnosis',async(t)=>{
  const f=fixture(t);f.setRecords([status('registry','dead')]);
  const fail=()=>assert.fail('terminal transport must remain untouched');
  f.terminals.set(ID,{id:ID,deckId:'deck',available:true,kill:fail,detach:fail,sockets:new Set([{close:fail}])} as unknown as TerminalSession);
  const response=await f.remove(true);assert.equal(response.status,409);
  const body=await response.json();assert.ok(body.blockers.some((e:{source:string;state:string})=>e.source==='memory'&&e.state==='live'));
  assert.equal(f.calls(),0);
});

test('late live native record rolls back DB cleanup and preserves deck',async(t)=>{
  const f=fixture(t);f.setRecords([status('registry','dead')]);f.legacy();f.setChange();
  const response=await f.remove(true);assert.equal(response.status,409);const body=await response.json();
  assert.equal(body.blockers[0].state,'live');assert.ok(f.decks.has('deck'));
  assert.ok(f.db.prepare('SELECT id FROM terminals WHERE id=?').get(ID));
});

test('database write failure retains all target rows and reports incomplete cleanup',async(t)=>{
  const f=fixture(t);f.legacy();f.native();
  f.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON decks BEGIN SELECT RAISE(ABORT,'private injected error'); END");
  const response=await f.remove(true);assert.equal(response.status,409);const body=await response.json();
  assert.ok(f.decks.has('deck'));assert.ok(f.db.prepare('SELECT id FROM terminals WHERE id=?').get(ID));
  assert.ok(f.db.prepare('SELECT id FROM terminal_metadata WHERE id=?').get(ID));
  assert.equal(JSON.stringify(body).includes('private injected error'),false);
});

test('pruning query is strict and unavailable DB-only rows cannot be removed',async(t)=>{
  const f=fixture(t);f.legacy();f.setState('unavailable');
  assert.equal((await f.router.request('/deck?pruneStale=false',{method:'DELETE'})).status,400);
  assert.equal((await f.remove(true)).status,409);assert.equal(f.calls(),0);
  assert.ok(f.db.prepare('SELECT id FROM terminals WHERE id=?').get(ID));
});

// The owner-only CLI caps structured diagnostics; a large deck must retain a useful refusal.
test('large blocker lists remain bounded and include an explicit remainder',async(t)=>{
  const f=fixture(t);f.setRecords(Array.from({length:130},(_,index)=>status('registry','dead',`terminal-${index}`)));
  const response=await f.remove();assert.equal(response.status,409);const body=await response.json();
  assert.equal(body.blockers.length,128);assert.equal(body.blockers[127].terminalId,'unknown');
  assert.match(body.blockers[127].reason,/3 additional blockers/);assert.equal(f.calls(),0);
});

test('pruning an unavailable dead display revokes its grant and closes only its viewers',async(t)=>{
  const f=fixture(t);const closed:unknown[][]=[];const fail=()=>assert.fail('native transport must remain untouched');
  const viewers=new Set([{close:(...args:unknown[])=>closed.push(args)}]);
  f.terminals.set(ID,{id:ID,deckId:'deck',available:false,kill:fail,detach:fail,sockets:viewers} as unknown as TerminalSession);
  assert.equal((await f.remove(true)).status,200);assert.deepEqual(f.revoked,[ID]);
  assert.deepEqual(closed,[[1000,'Terminal exited']]);assert.equal(viewers.size,0);assert.equal(f.terminals.has(ID),false);
});

test('invalid database IDs remain unavailable and are redacted in diagnostics',async(t)=>{
  const f=fixture(t);f.legacy('private-filename-secret');f.setState('unavailable');
  const response=await f.remove(true);assert.equal(response.status,409);const body=await response.json();
  assert.equal(body.blockers[0].terminalId,'unknown');assert.equal(JSON.stringify(body).includes('private-filename-secret'),false);
  assert.ok(f.db.prepare('SELECT id FROM terminals WHERE id=?').get('private-filename-secret'));assert.deepEqual(f.revoked,[]);
});
