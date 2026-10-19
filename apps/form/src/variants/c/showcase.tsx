import React, { useState } from 'react';
import { View } from 'react-native';
import { guide } from './generatedguide';
import { fixtures as F } from './generatedfixtures';
import { Box, Button, Content, Gutter, Header, MarginRow, Notice, Section, TopBar, Txt, type ControlState } from './primitives';
import { Compose, ConversationEntry, DayRow, DraftPanel, Mark, Segments, SessionSummary, SetRow, Stepper, TallyRow, Tick, WeekTally } from './components';
import { ConfirmationBody, Tabs } from './navigation';
import { WorkoutRail } from './screens';
import { Icon, type IconName } from './assets/icons';
import { t, s, shadow, MarginEnvironment, useMargin, type TypeRole } from './theme';
import { initialState, reducer, type DraftState, type State } from './model';

const slug=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const stateKey=(text:string)=>text.split(' (')[0].split(' /')[0].toLowerCase();
function controlState(name:string):ControlState {const key=stateKey(name);return key.includes('pressed')?'pressed':key==='disabled'?'disabled':key==='focus'?'focus':'default';}
function GuideRows({rows}:{rows:readonly (readonly string[])[]}) {
 return <Content>{rows.map((row,i)=><View key={i} style={{paddingVertical:t.space.sm,borderBottomWidth:t.border.hairline,borderBottomColor:t.role.line.ruling}}><Txt role="bodyStrong">{row[0]}</Txt>{row.slice(1).map((part,j)=><Txt key={j} role="metaMd" tone="secondary" style={s.detail}>{part}</Txt>)}</View>)}</Content>;
}
function GuideSection({name,title,children}:{name:string;title:string;children:React.ReactNode}) {return <Section heading={title} testID={`c-showcase-section-${name}`}>{children}</Section>;}
function resolve(path:string):unknown {return path.split('.').reduce<unknown>((obj,key)=>obj&&typeof obj==='object'?(obj as Record<string,unknown>)[key]:undefined,t);}
const iconNames:[IconName,string][]=[['today','notebook-pen'],['plan','calendar-days'],['workout','dumbbell'],['coach','message-square-text'],['progress','chart-bar'],['check','check'],['minus','minus'],['plus','plus'],['chevron','chevron-down'],['undo','undo-2'],['up','arrow-up'],['pen','pen-line'],['close','x']];
function Specimen({id,name}: {id:string;name:string}) {
 const env=useMargin();const key=stateKey(name),visualState=controlState(name),testID=`c-showcase-${id}-${slug(name)}`;
 const [replay,setReplay]=useState(0),[draft,setDraft]=useState<DraftState>(key==='applied'?'applied':key==='dismissed'?'dismissed':'draft'),[open,setOpen]=useState(key==='expanded'),[value,setValue]=useState(key==='at min'?1:key==='at max'?30:10),[note,setNote]=useState(key==='filled'?'Noted on today’s page.':''),[selected,setSelected]=useState<'sets'|'minutes'|'sessions'>('sets'),[used,setUsed]=useState(key==='used');
 const [tab,setTab]=useState<'today'|'plan'|'workout'|'coach'|'progress'>('today');
 const makeState=():State=>{
   const state=initialState('today',key==='saved'?'saved':key.includes('progress')?'confirmed':'default');
   if(key==='short')state.variant='short';
   if(key==='coach-changed'){state.squatSwap=true;state.drafts['box-squat']='applied';}
   return state;
 };
 const [local,setLocal]=useState(makeState);
 const act=(a:Parameters<typeof reducer>[1])=>setLocal(previous=>reducer(previous,a));
 const movement=F.movements['goblet-squat'];
 const specimen=(()=>{
 switch(id){
 case 'c01':return <MarginEnvironment.Provider value={{...env,stacked:key==='stacked'}}><Section heading="Today's session"><MarginRow word="Mon" value={5}><Txt role="titleMd">Full-body strength</Txt><Txt role="metaMd" tone="secondary">Logged · 11 sets · 34 min</Txt></MarginRow></Section></MarginEnvironment.Provider>;
 case 'c02':return <TopBar screen={`showcase-${testID}`} scrolled={key==='scrolled'}/>;
 case 'c03':return <Header screen={`showcase-${testID}`} date={F.calendar.todayLabel} title="Ready when you are, Alex." lead={key==='no lead'?undefined:'One session today, about 35 minutes.'}/>;
 case 'c04':return <View style={{minHeight:t.size.rowLogMin}}><Gutter word={key==='coach speaker'?'Coach':'Wed'} value={key==='coach speaker'?'7:24':7} state={key==='coach speaker'?'speaker':['current','done','muted'].includes(key)?key as 'current'|'done'|'muted':'default'} speaker={key==='coach speaker'}/></View>;
 case 'c05':return <SetRow movement={movement} index={1} active={key==='current'} value={key==='done'?{reps:10,loadKg:12}:undefined}/>;
 case 'c06':return <Content>{key==='hidden'?null:<Mark key={replay} fresh={key==='drawing'||replay>0} phase={key==='receding'?'receding':undefined}>10 × 12 kg</Mark>}<Button kind="text" label="Replay confirm" onPress={()=>setReplay(n=>n+1)}/></Content>;
 case 'c07':return <Content><Tick state={['empty','current','checked','disabled'].includes(key)?key as 'empty'|'current'|'checked'|'disabled':'empty'}/></Content>;
 case 'c08':return <Content><Button label="Confirm set 1" visualState={visualState} onPress={()=>setReplay(n=>n+1)}/></Content>;
 case 'c09':return <Content><Button label={key==='caution variant'?'Start over':'Move to Saturday'} kind="secondary" caution={key==='caution variant'} visualState={visualState}/></Content>;
 case 'c10':return <Content><Button label={key==='undo'?'Undo':key==='caution'||key==='confirmation opener'?'Start over':'Ask about today'} kind="text" icon={key==='undo'?'undo':undefined} caution={key==='caution'} visualState={visualState}/></Content>;
 case 'c11':return <Content>{key==='read-only'?<Mark>10 × 12 kg</Mark>:<View style={s.well}><Stepper field="reps" value={value} min={1} max={30} step={1} onChange={d=>setValue(v=>Math.max(1,Math.min(30,v+d)))} testID={testID+'-reps'} visualState={visualState}/></View>}</Content>;
 case 'c12':return <Content><Segments metric={key==='unselected'?'minutes':selected} onChange={setSelected} prefix={testID+'-'} visualState={visualState}/></Content>;
 case 'c13':return <SessionSummary state={local} testID={testID+'-summary'}/>;
 case 'c14':return <Content><WeekTally saved={key==='today saved'} moved={key==='moved'} testID={testID+'-week'}/></Content>;
 case 'c15':return <DayRow day={key==='target of a move'?'Sat':'Wed'} number={key==='target of a move'?10:7} title={key==='rest'?'Rest':'Full-body strength'} detail={key==='rest'?'A walk is plenty.':key==='logged'?'Logged · 11 sets · 34 min':'Today · 35 min · 5 movements'} session={key!=='rest'} current={key==='today'} done={key==='logged'} changed={key==='changed'||key==='target of a move'} open={open} onPress={()=>setOpen(v=>!v)} visualState={visualState}>{key==='logged'?<Txt role="metaMd">Logged · 11 sets · 34 min</Txt>:<Button kind="secondary" label={key==='planned'?'Move to Saturday':'Use the 20-minute version'}/>}</DayRow>;
 case 'c16':return key==='hidden'?null:<Notice text={key==='after undo'?'Undone.':"Friday's session moved to Saturday."} undo={key==='after undo'?undefined:()=>setUsed(true)} testID={testID+'-undo'}/>;
 case 'c17':return <DraftPanel draftKey="box-squat" state={draft} fresh={replay>0} onApply={()=>{setDraft('applied');setReplay(n=>n+1);}} onUndo={()=>setDraft('draft')} onDismiss={()=>setDraft('dismissed')} onReopen={()=>setDraft('draft')} testID={testID+'-panel'}/>;
 case 'c18':return <ConversationEntry index={Number(id.slice(1))} testID={testID+'-entry'} entry={key==='you'?F.coach.opening[0]:{speaker:'coach',time:'7:24',text:F.progress.consistencyNote}}/>;
 case 'c19':return <Content>{key==='none left'?<Txt role="metaMd" tone="secondary">That's all the suggestions for today.</Txt>:used?null:<Button label="Make today shorter" kind="chip" visualState={visualState} onPress={()=>setUsed(true)}/>}</Content>;
 case 'c20':return <Content><Compose value={note} onChange={setNote} onSend={()=>setNote('')} forceFocus={key==='focused'} testID={testID+'-compose'}/></Content>;
 case 'c21':return <TallyRow month="Sep" day="28" value={key==='zero'?0:28} metric="sets" current={key==='current week'} open={open} onPress={()=>setOpen(v=>!v)} entries={F.progress.weekSessions['Sep 28']} testID={testID+'-tally'} visualState={visualState}/>;
 case 'c22':{
  const sample=initialState('workout',key==='saved'?'saved':key.includes('undo')?'confirmed':'default');
  if(key==='movement done')sample.confirmed['goblet-squat']=[{reps:10,loadKg:12},{reps:10,loadKg:12},{reps:10,loadKg:12}];
  if(key==='last movement done'){sample.movementIndex=4;sample.confirmed['calf-raise']=[{reps:12,loadKg:0},{reps:12,loadKg:0}];}
  return <WorkoutRail state={sample} act={()=>{}} prefix={testID+'-'}/>;
 }
 case 'c23':return <Tabs screen={tab} onChange={setTab} prefix={testID+'-tab-'} visualState={visualState}/>;
 case 'c24':return key==='closed'?null:<ConfirmationBody count={1} prefix={testID+'-'} includeInset={false}/>;
 case 'c25':return <MarginRow word="C-07"><Txt role="titleMd">Tick box</Txt><Txt role="metaMd" tone="secondary">An indicator, not a control.</Txt><Txt role="labelSm" tone="secondary" style={s.gap}>Checked</Txt><Tick state="checked"/></MarginRow>;
 default:return null;
 }
 })();
 return <Box testID={testID} style={{marginBottom:t.space.xl}}><Content><Txt role="labelSm" tone="secondary" style={{marginBottom:t.space.xs}}>{name}</Txt></Content>{specimen}</Box>;
}
export function Showcase() {
 const env=useMargin();const [replay,setReplay]=useState(0);
 const roles=guide.tokens.filter(item=>item.path.startsWith('role.')&&typeof resolve(item.path)==='string');
 return <>
  <Header screen="showcase" date="Form · System" title="Margin" lead={guide.thesis}/>
  <GuideSection name="thesis" title="Margin"><Content><Txt>Spacious, legible, accountable.</Txt><Txt tone="secondary" style={s.smallGap}>Avoid clinical, cute, hyped.</Txt><Txt style={s.gap}>The page title and the main action are the only elements that cross the margin, like an editorial headline breaking the column. Everything else keeps to the grid.</Txt></Content></GuideSection>
  <GuideSection name="sources" title="Sources → decisions"><GuideRows rows={guide.sources}/></GuideSection>
  <GuideSection name="color" title="Color roles">{roles.map(role=><MarginRow key={role.path} ruled><View style={{position:'absolute',left:-(t.layout.contentLeft-t.layout.gutterLeft),width:t.size.tickBox,height:t.size.tickBox,borderRadius:t.radius.xs,borderWidth:t.border.hairline,borderColor:t.role.line.ruling,backgroundColor:resolve(role.path) as string}}/><Txt role="bodyStrong">{role.path}</Txt><Txt role="entrySm" tone="secondary" style={s.detail}>{String(resolve(role.path))}</Txt><Txt role="metaMd" tone="secondary" style={s.detail}>{role.description||role.path.split('.').slice(1).join(' · ')}</Txt></MarginRow>)}</GuideSection>
  <GuideSection name="contrast" title="Contrast"><GuideRows rows={guide.contrast}/></GuideSection>
  <GuideSection name="forbidden" title="Never combine"><GuideRows rows={guide.forbidden}/></GuideSection>
  <GuideSection name="type" title="Type specimens">{(Object.keys(t.type) as TypeRole[]).map(role=><Content key={role} style={{marginBottom:t.space.xl}}><Txt role="entrySm" tone="secondary">{role} · {t.type[role].fontSize}/{t.type[role].lineHeight}</Txt><Txt role={role} style={s.smallGap}>{role.startsWith('entry')||role.startsWith('figure')?'10 × 12 kg':role.startsWith('note')?F.progress.consistencyNote:role==='wordmark'?'Form':'Ready when you are, Alex.'}</Txt><Txt role="metaMd" tone="secondary" style={s.detail}>{t.type[role].fontFamily}</Txt></Content>)}</GuideSection>
  <GuideSection name="grid" title="Space and the margin"><MarginRow word="Mon" value={5}><Txt role="titleMd">Full-body strength</Txt><Txt role="metaMd" tone="secondary">Gutter 44 · Rule x 72 · Content x 88</Txt></MarginRow><Content>{Object.entries(t.space).map(([name,size])=><View key={name} style={{paddingVertical:t.space.xs}}><Txt role="entrySm">space.{name} · {size}</Txt><View style={{width:size,height:t.border.focus,backgroundColor:t.role.line.margin,marginTop:t.space.xxs}}/></View>)}</Content></GuideSection>
  <GuideSection name="surfaces" title="Surfaces and shape"><Content><Txt role="metaMd" tone="secondary">{guide.separation}</Txt><View style={{marginTop:t.space.md,padding:t.space.md,backgroundColor:t.role.surface.page}}><Txt>Page</Txt></View><View style={s.well}><Txt>Well</Txt></View><View style={{padding:t.space.md,marginTop:t.space.md,borderWidth:t.border.control,borderColor:t.role.line.selected,borderRadius:t.radius.sm,backgroundColor:t.role.surface.raised}}><Txt>Raised panel</Txt></View><View style={{padding:t.space.md,marginTop:t.space.md,borderTopWidth:t.border.hairline,borderTopColor:t.role.line.ruling,backgroundColor:t.role.surface.bar}}><Txt>Bar</Txt></View><View style={{padding:t.space.lg,marginTop:t.space.md,borderTopLeftRadius:t.radius.lg,borderTopRightRadius:t.radius.lg,backgroundColor:t.role.surface.raised,boxShadow:shadow('sheet')}}><Txt>Sheet</Txt></View>{Object.entries(t.radius).map(([key,radius])=><View key={key} style={{flexDirection:'row',gap:t.space.sm,alignItems:'center',marginTop:t.space.sm}}><View style={{width:t.size.touchMin,height:t.size.touchMin,borderRadius:radius,borderWidth:t.border.control,borderColor:t.role.line.control}}/><Txt role="metaMd">{key} · {radius}</Txt></View>)}</Content></GuideSection>
  <GuideSection name="icons" title="Icons"><Content><View style={{gap:t.space.md}}>{iconNames.map(([name,label])=><View key={name} style={{flexDirection:'row',gap:t.space.sm,alignItems:'center'}}><Icon name={name}/><Txt role="metaMd">{label}</Txt></View>)}</View></Content></GuideSection>
  <GuideSection name="motion" title="Motion and Reduce Motion"><GuideRows rows={guide.motion}/><MarginRow word="Set" value={1}><View style={s.row}><View style={s.copy}><Mark key={replay} fresh={replay>0}>10 × 12 kg</Mark></View><Tick key={`tick-${replay}`} state="checked" fresh={replay>0}/></View><Button kind="text" label="Replay confirm" testID="c-showcase-replay" onPress={()=>setReplay(n=>n+1)}/><Txt role="metaMd" tone="secondary">{env.reducedMotion?'Reduce Motion: opacity only.':'Swipe and tick draw together.'}</Txt></MarginRow><MarginEnvironment.Provider value={{...env,reducedMotion:true}}><MarginRow word="Set" value={1}><Mark key={`rm-${replay}`} fresh={replay>0}>10 × 12 kg</Mark><Txt role="metaMd" tone="secondary">Reduce Motion · 120 ms opacity</Txt></MarginRow></MarginEnvironment.Provider></GuideSection>
  <GuideSection name="voice" title="Voice · Do / Don’t"><GuideRows rows={guide.voice}/></GuideSection>
  <GuideSection name="a11y" title="Accessibility"><GuideRows rows={guide.a11y}/></GuideSection>
  <GuideSection name="pages" title="Page purposes"><GuideRows rows={guide.purposes}/></GuideSection>
  <GuideSection name="flow" title="Local flow"><Content>{guide.flow.map((paragraph,i)=><Txt key={i} role="metaMd" tone="secondary" style={{marginBottom:t.space.md}}>{paragraph}</Txt>)}<Txt role="bodyStrong">Fictional fixtures</Txt><Txt role="metaMd" tone="secondary" style={s.smallGap}>{F.$schema_note}</Txt><Txt role="entrySm" style={s.smallGap}>{F.calendar.todayLabel} · {F.person.name}</Txt></Content></GuideSection>
  <GuideSection name="components" title="Components · anatomy and states">{guide.components.map(component=><Box key={component.id} testID={`c-showcase-${component.key}`} style={{marginBottom:t.layout.sectionGap}}><MarginRow word={component.id}><Txt role="titleMd">{component.name}</Txt><Txt role="metaMd" tone="secondary" style={s.smallGap}>{component.anatomy.split('|')[0].trim()}</Txt></MarginRow>{component.states.map(state=><React.Fragment key={state.name}><Specimen id={component.key} name={state.name}/><Content><Txt role="metaMd" tone="secondary" style={{marginBottom:t.space.lg}}>{state.description}</Txt></Content></React.Fragment>)}</Box>)}</GuideSection>
 </>;
}
