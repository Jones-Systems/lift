"use strict";
const fs=require("node:fs"), path=require("node:path"), vm=require("node:vm"), crypto=require("node:crypto"), assert=require("node:assert/strict"), ts=require("typescript");
const root=path.resolve(__dirname,"../src/variants/a"), loaded=new Map(), sources={}, extracted=[];
function load(file){
 file=path.resolve(file);assert(file.startsWith(root+path.sep));if(loaded.has(file))return loaded.get(file).exports;
 let source=fs.readFileSync(file,"utf8");sources[path.relative(root,file)]=crypto.createHash("sha256").update(source).digest("hex");
 if(path.basename(file)==="components.tsx"){
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const selected=ast.statements.filter(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&["setsOf","COMPOSER_LIMIT"].includes(d.name.text)));
  assert.equal(selected.length,2);source=selected.map(s=>s.getText(ast)).join("\n");extracted.push("components.tsx: actual exported setsOf and COMPOSER_LIMIT declarations; no substituted functions");
 }
 const module={exports:{}};loaded.set(file,module);
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const requireLocal=id=>{assert(id.startsWith("."));const base=path.resolve(path.dirname(file),id);return load(fs.existsSync(base+".ts")?base+".ts":base+".tsx");};
 vm.runInNewContext(output,{module,exports:module.exports,require:requireLocal},{filename:file,timeout:2000});return module.exports;
}
const m=load(path.join(root,"model.ts")),checks=[];
function check(name,ok){assert(ok,name);checks.push({name,status:"pass"});}
const reduce=m.reducer;let s=m.launchState("workout");
check("ordinary workout has zero confirmed sets",s.confirmed.length===0);
check("zero-set save invents no history",reduce(s,{type:"save"}).history.length===s.history.length);
check("unconfirmed next cannot advance",reduce(s,{type:"next-set"}).session.set===1);
const invalid={...s,draft:{...s.draft,reps:0}};
check("invalid repetitions cannot record",reduce(invalid,{type:"confirm-set",now:1000}).confirmed.length===0);
s=reduce(s,{type:"confirm-set",now:1000});
check("explicit confirmation records exactly one set",s.confirmed.length===1&&s.session.status==="resting");
check("duplicate confirmation is idempotent",reduce(s,{type:"confirm-set",now:1001}).confirmed.length===1);
check("timer derives its countdown from the stored end time",m.remainingRest(s.session,1000)===60&&m.remainingRest(s.session,61000)===0);
s=reduce(s,{type:"end-rest"});
check("rest expiry records nothing and waits for next",s.confirmed.length===1&&s.session.status==="ready-next");
s=reduce(s,{type:"next-set"});
check("next opens the next editor without recording it",s.confirmed.length===1&&s.session.set===2&&s.session.status==="active");
const saved=reduce(s,{type:"save"});
check("partial save records only actual confirmed work",saved.history[0].sets===1&&saved.history[0].partial&&saved.session===null);
let plan=reduce(m.initialState(),{type:"apply-short"});
check("adaptation changes planned work without inventing records",m.planTotals(plan.plan).sets===7&&plan.confirmed.length===0);
plan=reduce(plan,{type:"undo-short"});
check("undo restores the full planned session",m.planTotals(plan.plan).sets===11&&plan.confirmed.length===0);
const guarded=reduce(s,{type:"apply-short"});check("an active session cannot be replaced by a shorter plan",guarded.plan===s.plan&&guarded.confirmed.length===1);
const tooLong=reduce(m.initialState(),{type:"composer",text:"x".repeat(281)});check("over-limit coach text is not sent",reduce(tooLong,{type:"coach-send"}).chat.length===tooLong.chat.length);
const output={schema:"form2-model-behavior/v1",direction:"a",checks,sources,extracted,scope:"Actual model and generated inputs transpiled in memory; actual pure component exports selected by TypeScript AST; UI and native behavior are separate."};
fs.writeFileSync(path.resolve(__dirname,"../evidence/a-model-behavior-checks.json"),JSON.stringify(output,null,2)+"\n");console.log(JSON.stringify({status:"pass",checks:checks.length}));
