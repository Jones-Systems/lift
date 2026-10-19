import React from 'react';
import { View } from 'react-native';
import { Box, Button, Content, Header, Section, Note, Notice, Txt, MarginRow } from './primitives';
import { ActiveSet, Compose, ConversationEntry, DayRow, DraftPanel, Mark, Previews, Segments, SessionSummary, SetRow, StartedReason, TallyRow, Tick, WeekTally } from './components';
import { fixtures as F } from './generatedfixtures';
import { t, s } from './theme';
import { type Action, type State, type MovementId, type Entry, confirmedCount, movements, setsFor, recordedMinutes, setText } from './model';
export type PageProps={state:State;act:(action:Action)=>void};
function PageNotice({state,act,page=state.screen}:PageProps&{page?:State['screen']}) {
 const notice=state.notices[page];
 return notice?<Notice text={notice.text} undo={notice.undo?()=>act({type:'undo-notice',page}):undefined} testID={`c-${page}-${notice.undo==='skip'?'skip-undo':'undo'}`}/>:null;
}
export function Today({state,act}:PageProps) {
 const count=confirmedCount(state);
 return <>
   <Header screen="today" date={F.calendar.todayLabel} title={'Ready when\nyou are, Alex.'} lead={`One session today, about ${F.sessions[state.variant].minutes} minutes.`}/>
   <Section heading="Today’s session"><SessionSummary state={state}/></Section>
   <Box style={{marginHorizontal:t.layout.screenInsetX,marginBottom:t.layout.sectionGap}}><Button label={state.saved?"Review today's log":count?'Continue workout':'Start workout'} kind={state.saved?'secondary':'primary'} testID="c-today-start" onPress={()=>act({type:'tab',screen:'workout'})}/></Box>
   <Section heading="In this session"><Content><Previews state={state} afterSectionHeading/><Button label={state.variant==='full'?'Use the 20-minute version':'Back to 35 minutes'} kind="text" testID="c-today-version" disabled={!!count} onPress={()=>act({type:'version',page:'today'})}/>{!!count&&<StartedReason/>}</Content></Section>
   <PageNotice state={state} act={act}/>
   <Section><Note testID="c-today-note" startsSection>{state.squatSwap?'Box squats today. Use a comfortable range and stop if it hurts.':"Monday’s squats moved well at 10 kg. I’d try 12 kg today."}</Note><Content><Button kind="text" label="Ask about today" testID="c-today-ask" onPress={()=>act({type:'tab',screen:'coach'})}/></Content></Section>
   <Section heading="This week"><Content><WeekTally saved={state.saved} moved={state.friMoved}/><Button label="See the plan" kind="text" testID="c-today-see-plan" onPress={()=>act({type:'tab',screen:'plan'})}/></Content></Section>
 </>;
}
export function Plan({state,act}:PageProps) {
 const count=confirmedCount(state),list=movements(state);
 return <>
   <Header screen="plan" date={F.calendar.weekLabel} title="This week’s plan" lead="Three sessions, about 35 minutes each. Nothing moves unless you move it."/>
   <Section heading={F.calendar.weekRange}>{F.week.map(day=>{
     let session=day.kind==='session',title:string=day.title,detail:string=day.detail;const current=day.key==='wed';
     if(state.friMoved&&day.key==='fri'){session=false;title='Rest';detail='Moved to Saturday';}
     if(state.friMoved&&day.key==='sat'){session=true;title='Full-body strength';detail='Planned · 35 min · 5 movements';}
     if(current)detail=state.saved?`Today · logged · ${count} sets`:`Today · ${F.sessions[state.variant].minutes} min · ${list.length} movements`;
     return <React.Fragment key={day.key}><DayRow testID={`c-plan-day-${day.key}`} day={day.dayShort} number={day.dayNumber} title={title} detail={detail} current={current} done={day.key==='mon'||current&&state.saved} session={session} changed={state.friMoved&&day.key==='sat'} open={state.planExpanded===day.key} onPress={()=>act({type:'expand-plan',day:day.key})}>
       {day.key==='mon'?<Txt role="metaMd">Logged · 11 sets · 34 min</Txt>:current?<><Previews state={state} prefix="c-plan-preview-"/><Button label={state.variant==='full'?'Use the 20-minute version':'Back to 35 minutes'} kind="secondary" testID="c-plan-wed-version" disabled={!!count} onPress={()=>act({type:'version',page:'plan'})}/>{!!count&&<StartedReason/>}<Button label="Open workout" kind="text" testID="c-plan-wed-open" onPress={()=>act({type:'tab',screen:'workout'})}/></>:<Button label={state.friMoved?'Move back to Friday':'Move to Saturday'} kind="secondary" testID={`c-plan-${day.key}-move`} onPress={()=>act({type:'move'})}/>}
     </DayRow>{day.key==='sat'&&state.notices.plan?.undo==='move'&&<PageNotice state={state} act={act}/>}</React.Fragment>;
   })}</Section>
   {state.notices.plan?.undo!=='move'&&<PageNotice state={state} act={act}/>}
   <Section heading="Next week"><Content><Txt tone="secondary" testID="c-plan-next">Next week’s plan appears after Sunday. It builds on what you log this week.</Txt><Button label="Reset this week" kind="text" testID="c-plan-reset" disabled={!state.friMoved&&state.variant==='full'} onPress={()=>act({type:'reset-plan'})}/></Content></Section>
 </>;
}
export function Workout({state,act}:PageProps) {
 const count=confirmedCount(state),list=movements(state),m=list[state.movementIndex],values=state.confirmed[m.id]??[];
 if(state.saved)return <>
   <Header screen="workout" date={`Saved · ${F.calendar.todayLabel}`} title="Saved." lead={`${count} confirmed ${count===1?'set is':'sets are'} in your log. Sets you didn’t confirm aren’t recorded.`}/>
   <Section heading="Today’s log">{Object.entries(state.confirmed).filter(([,a])=>a.length).map(([id,rows])=><React.Fragment key={id}><Content><Txt role="titleMd" testID={`c-workout-log-${id}`}>{F.movements[id as MovementId].name}</Txt></Content>{rows.map((value,i)=><MarginRow key={i} ruled word="Set" value={i+1}><View style={s.row}><Mark>{setText(value,id as MovementId)}</Mark><Tick state="checked"/></View></MarginRow>)}</React.Fragment>)}</Section>
   <PageNotice state={state} act={act}/>
   <Content><Button label="Start over" kind="text" testID="c-workout-reset" onPress={()=>act({type:'reset-open'})}/></Content>
 </>;
 return <>
   <Header screen="workout" date={`Movement ${state.movementIndex+1} of ${list.length} · ${F.sessions[state.variant].minutes}-minute session`} title={m.name} lead={m.loadKg?`${setsFor(state,m)} sets of ${m.repsTarget} at ${m.loadLabel}.`:`${setsFor(state,m)} sets of ${m.repsTarget}, body weight.`}/>
   <Section heading="Your sets">{Array.from({length:setsFor(state,m)},(_,i)=><SetRow key={`${m.id}-${i}`} testID={`c-workout-set-${i+1}`} movement={m} index={i+1} value={values[i]} active={i===values.length} fresh={state.feedback>0&&state.lastAction==='confirm'&&i===values.length-1}>{i===values.length&&<ActiveSet movement={m} value={state.draftSet} onChange={(field,delta)=>act({type:'adjust',field,delta})}/>}</SetRow>)}</Section>
   <Section><Note testID="c-workout-note">{m.id==='goblet-squat'?'Last Monday: 10 reps at 10 kg. Try 12 kg if the last rep stays smooth.':m.id==='box-squat'?'Easy on the knee: touch the bench lightly, then stand. Stop if it gets sharper.':`Last Monday: ${m.last.reps} × ${m.last.loadLabel}.`}</Note></Section>
   <Section heading="How to move">{m.cues.map((cue,i)=><MarginRow cue key={cue} word="" value={i+1} gutterState="muted" testID={`c-workout-cue-${i+1}`}><Txt>{cue}</Txt></MarginRow>)}</Section>
   <PageNotice state={state} act={act}/>
   <Content><Button kind="text" label="Skip this movement" testID="c-workout-skip" onPress={()=>act({type:'skip'})}/>{state.movementIndex>0&&<Button kind="text" label={`Back to ${list[state.movementIndex-1].name}`} testID="c-workout-prev" onPress={()=>act({type:'prev'})}/>}<Button kind="text" label="Finish early and save" testID="c-workout-finish-early" disabled={!count} onPress={()=>act({type:'save'})}/>{count?<Button kind="text" label="Start over" testID="c-workout-reset" onPress={()=>act({type:'reset-open'})}/>:<Txt role="metaMd" tone="secondary">Confirm at least one set to save.</Txt>}</Content>
 </>;
}
export function WorkoutRail({state,act,prefix='c-workout-'}:PageProps&{prefix?:string}) {
 const list=movements(state),m=list[state.movementIndex],count=state.confirmed[m.id]?.length??0,done=count>=setsFor(state,m),last=state.movementIndex===list.length-1;
 return <Box testID={prefix+'rail'} style={{height:t.layout.actionRailHeight,paddingHorizontal:t.space.lg,paddingVertical:t.space.sm,borderTopWidth:t.border.hairline,borderTopColor:t.role.line.ruling,flexDirection:'row',gap:t.space.sm,alignItems:'center',backgroundColor:t.role.surface.bar}}>
   {state.saved?<Button label="Back to Today" kind="secondary" style={[s.flex,{alignSelf:'center'}]} testID={prefix+'back-today'} onPress={()=>act({type:'tab',screen:'today'})}/>:<>{state.lastAction==='confirm'&&<Button kind="text" label="Undo" testID={prefix+'undo'} onPress={()=>act({type:'undo-set'})}/>}<Button label={done?(last?'Finish and save':`Next: ${list[state.movementIndex+1].name}`):`Confirm set ${count+1}`} style={s.flex} testID={prefix+(done?(last?'finish':'next'):'confirm')} onPress={()=>act({type:done?(last?'save':'next'):'confirm'})}/></>}
 </Box>;
}
export function Coach({state,act}:PageProps) {
 const started=!!confirmedCount(state);
 const panel=(key:'box-squat'|'short',afterSection=false)=><DraftPanel key={key} draftKey={key} state={state.drafts[key]} started={started} fresh={state.feedback>0} afterSection={afterSection} onApply={()=>act({type:'draft',key,operation:'apply'})} onUndo={()=>act({type:'draft',key,operation:'undo'})} onDismiss={()=>act({type:'draft',key,operation:'dismiss'})} onReopen={()=>act({type:'draft',key,operation:'reopen'})}/>;
 return <>
   <Header screen="coach" date={F.coach.context} title={'Notes with\nyour coach'} lead="Suggestions are drafts. Nothing changes until you apply it."/>
   <Section>{F.coach.opening.map((entry,i)=><ConversationEntry key={i} entry={entry} index={i} endsSection={i===F.coach.opening.length-1}/>)}</Section>
   {panel('box-squat',true)}<PageNotice state={state} act={act}/>
   {state.entries.map((entry,i)=><React.Fragment key={i}><Section><ConversationEntry entry={entry} index={i+F.coach.opening.length}/></Section>{entry.draft&&panel(entry.draft)}</React.Fragment>)}
   {state.drafts.short==='applied'&&!state.entries.some(e=>e.draft==='short')&&panel('short')}
   <Section><Content><Txt role="metaMd" tone="secondary">Ask next</Txt><View style={{flexDirection:'row',flexWrap:'wrap',gap:t.space.xs,marginTop:t.space.xs}}>{F.coach.suggestions.filter(c=>!state.used.includes(c.id)).map(c=><Button key={c.id} kind="chip" label={c.chip} testID={`c-coach-chip-${c.id}`} onPress={()=>act({type:'chip',id:c.id})}/>)}{state.used.length===F.coach.suggestions.length&&<Txt role="metaMd" tone="secondary">That’s all the suggestions for today.</Txt>}</View><Compose value={state.compose} onChange={text=>act({type:'compose',text})} onSend={()=>act({type:'send'})}/><Txt role="metaMd" tone="secondary" testID="c-coach-disclaimer" style={s.smallGap}>{F.coach.disclaimer}</Txt><Button kind="text" label="Clear notes" testID="c-coach-clear" onPress={()=>act({type:'clear-notes'})}/></Content></Section>
 </>;
}
export function Progress({state,act}:PageProps) {
 const count=confirmedCount(state),minutes=recordedMinutes(state),metric=state.metric;
 const added=Object.entries(state.confirmed).flatMap(([id,rows])=>rows.map(row=>({id:id as MovementId,row}))).sort((a,b)=>b.row.loadKg-a.row.loadKg||b.row.reps-a.row.reps)[0];
 const recent=state.saved&&added?[{dayShort:'Wed',dayNumber:7,title:state.variant==='short'?'Short version':'Full-body strength',entry:`${count} sets · ${minutes} min`,best:`${F.movements[added.id].name} ${setText(added.row,added.id)}`},...F.progress.recent]:F.progress.recent;
 return <>
  <Header screen="progress" date="Last 8 weeks" title={'What you’ve\nlogged'} lead={F.progress.leads[metric]}/>
  <Section><Content><Segments metric={metric} onChange={metric=>act({type:'metric',metric})}/></Content>{F.progress.weeks.map((week,i)=>{
   const current='current' in week&&week.current,[month,day]=week.start.split(' ');
   const value=week[metric]+(current?(metric==='sets'?count:state.saved?(metric==='minutes'?minutes:1):0):0);
   const weeks=F.progress.weekSessions as Record<string,readonly string[]>;
   const entries=[...(weeks[week.start]??weeks.default),...(current&&state.saved?[`Wed Oct 7 · ${state.variant==='short'?'Short version':'Full-body strength'} · ${count} sets · ${minutes} min`]:[])];
   return <TallyRow key={week.start} month={month} day={day} value={value} metric={metric} current={current} open={state.weekExpanded===i} onPress={()=>act({type:'expand-week',index:i})} entries={entries} testID={`c-progress-week-${i}`}/>;
  })}<Note testID="c-progress-note">{F.progress.consistencyNote}</Note></Section>
  <Section heading="Recent entries">{recent.map((entry,i)=><MarginRow key={`${entry.dayShort}-${entry.dayNumber}`} ruled word={entry.dayShort} value={entry.dayNumber} testID={`c-progress-entry-${i}`}><Txt role="titleMd">{entry.title}</Txt>{state.saved&&i===0?<Mark role="entrySm">{entry.entry}</Mark>:<Txt role="entrySm" tone="secondary" style={s.detail}>{entry.entry}</Txt>}<Txt role="metaMd" tone="secondary" style={s.detail}>Best set: {entry.best}</Txt></MarginRow>)}</Section>
 </>;
}
