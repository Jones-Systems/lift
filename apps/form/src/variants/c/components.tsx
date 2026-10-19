import React, { useEffect, useState } from 'react';
import { View, Pressable, TextInput, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Icon } from './assets/icons';
import { Box, Txt, Button, Content, Gutter, MarginRow, Disclosure, Mark, type ControlState } from './primitives';
import { t, s, focusStyle, textStyle, useMargin, easingOut, easingStandard, type TypeRole } from './theme';
import { TickMark } from './assets/tick-mark';
import { useFrame } from './capture';
import { fixtures as F } from './generatedfixtures';
import { type Movement, type MovementId, type SetValue, type State, type DraftKey, type DraftState, type Entry, type Metric, movements, setsFor, confirmedCount, plannedCount, setText } from './model';

export { Mark } from './primitives';
export function Tick({state='empty',small=false,fresh=false}: {state?:'empty'|'current'|'checked'|'disabled';small?:boolean;fresh?:boolean}) {
 const {reducedMotion}=useMargin();const value=useSharedValue(fresh?0:1);
 useEffect(()=>{if(fresh){value.value=0;value.value=withTiming(1,{duration:reducedMotion?t.motion.duration.reducedFade:t.motion.duration.tick,easing:easingOut});}},[fresh,reducedMotion,value]);
 const animation=useAnimatedStyle(()=>({opacity:value.value}));
 return <View accessible={false} style={{width:small?t.size.weekTick:t.size.tickBox,height:small?t.size.weekTick:t.size.tickBox,borderRadius:t.radius.xs,borderCurve:'continuous',borderWidth:t.border.tick,borderColor:state==='current'||state==='checked'?t.role.line.selected:state==='disabled'?t.role.icon.disabled:t.role.line.control,backgroundColor:state==='checked'?t.role.action.primaryBg:t.role.surface.page,alignItems:'center',justifyContent:'center',flexShrink:0}}>
   {state==='checked'&&<TickMark progress={value} reduced={reducedMotion}/>}
 </View>;
}
export function Previews({state,prefix='c-today-move-',afterSectionHeading=false}:{state:State;prefix?:string;afterSectionHeading?:boolean}) {
 const {stacked}=useMargin();
 return <View style={{marginTop:afterSectionHeading?t.space.none:t.space.sm}}>{movements(state).map(m=><Box key={m.id} testID={prefix+m.id} style={{flexDirection:stacked?'column':'row',justifyContent:'space-between',gap:stacked?t.space.none:t.space.sm,paddingVertical:t.space.xxs,minHeight:t.space.xxl,alignItems:'flex-start'}}>
   <View style={stacked?undefined:s.copy}>{state.squatSwap&&m.id==='box-squat'?<Mark role="bodyMd">{m.name}</Mark>:<Txt>{m.name}</Txt>}</View>
   <Txt role="entrySm" tone="secondary" style={{paddingTop:t.space.hair,flexShrink:0}}>{setsFor(state,m)} × {m.repsTarget}</Txt>
 </Box>)}</View>;
}
export function SessionSummary({state,testID='c-today-session'}:{state:State;testID?:string}) {
 const count=confirmedCount(state),list=movements(state);
 return <MarginRow testID={testID} word="min" value={F.sessions[state.variant].minutes} gutterState="current" marked={state.variant==='short'}>
   <Txt role="titleMd">Full-body strength</Txt><Txt role="metaMd" tone="secondary" style={s.detail}>{state.saved?`Saved · ${count} sets`:`${list.length} movements · ${plannedCount(state)} sets${count?` · ${count} of ${plannedCount(state)} sets confirmed`:''}`}</Txt>
 </MarginRow>;
}
export function WeekTally({saved=false,moved=false,testID='c-today-week'}:{saved?:boolean;moved?:boolean;testID?:string}) {
 return <Box testID={testID} accessibilityLabel={`This week: Monday logged, Wednesday ${saved?'logged':'today'}, ${moved?'Saturday':'Friday'} planned.`}>
   <Txt>{saved?`2 of 3 sessions logged. Next: ${moved?'Saturday':'Friday'}.`:'1 of 3 sessions logged. Today is next.'}</Txt>
   <View style={{flexDirection:'row',gap:t.space.xl,minHeight:t.size.touchMin,alignItems:'center',marginTop:t.space.sm}}>{(['Mon','Wed',moved?'Sat':'Fri'] as const).map((day,i)=><View key={day} style={{flexDirection:'row',gap:t.space.xs,alignItems:'center'}}><Tick small state={i===0||i===1&&saved?'checked':i===1?'current':'empty'}/><Txt role="labelSm">{day}</Txt></View>)}</View>
 </Box>;
}
export function Stepper({field,value,min,max,step,onChange,testID,visualState='default'}:{field:'reps'|'load';value:number;min:number;max:number;step:number;onChange?:(delta:number)=>void;testID?:string;visualState?:ControlState}) {
 const {stacked}=useMargin(); const [focused,setFocused]=useState(false);const base=testID??`c-workout-${field}`;
 const valueFrame=useFrame<View>(`${base}-value`);
 return <View accessibilityRole="adjustable" accessibilityLabel={field==='reps'?'Reps':'Load'} accessibilityValue={{min,max,now:value,text:field==='reps'?`${value} reps`:value?`${value} kilograms`:'Body weight'}} accessibilityActions={[{name:'increment'},{name:'decrement'}]} onAccessibilityAction={e=>onChange?.(e.nativeEvent.actionName==='increment'?step:-step)} style={[{flexDirection:'row',alignItems:'center',gap:t.space.xs,minHeight:t.size.stepperHeight,flexWrap:stacked?'wrap':'nowrap'},(focused||visualState==='focus')&&focusStyle]}>
   <Txt role="labelSm" tone="secondary" style={stacked?{flexBasis:'100%'}:{width:t.render.stepperLabelWidth,flexShrink:0}}>{field==='reps'?'Reps':'Load (kg)'}</Txt>
   {['minus','value','plus'].map(part=>part==='value'?<View key={part} {...valueFrame} testID={`${base}-value`} style={{flex:1,minWidth:t.size.stepperValueMinWidth,alignItems:'center',justifyContent:'center'}}><Txt role={field==='load'&&value===0?'metaMd':'figureLg'}>{field==='load'&&value===0?'Body weight':value}</Txt></View>:<Pressable key={part} testID={`${base}-${part}`} accessibilityRole="button" accessibilityLabel={field==='reps'?(part==='minus'?'Fewer reps':'More reps'):(part==='minus'?'Less load':'More load')} accessibilityState={{disabled:part==='minus'?value<=min:value>=max}} disabled={part==='minus'?value<=min:value>=max} onPress={()=>onChange?.(part==='minus'?-step:step)} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} style={({pressed})=>({width:t.size.stepperButton,height:t.size.stepperButton,alignItems:'center',justifyContent:'center',borderWidth:t.border.control,borderColor:(part==='minus'?value<=min:value>=max)?t.role.icon.disabled:t.role.line.control,borderRadius:t.radius.xs,borderCurve:'continuous',backgroundColor:pressed||visualState==='pressed'?t.role.surface.pressed:undefined,flexShrink:0})}><Icon name={part as 'minus'|'plus'} color={(part==='minus'?value<=min:value>=max)?t.role.icon.disabled:t.role.icon.default}/></Pressable>)}
 </View>;
}
export function ActiveSet({movement,value,onChange}:{movement:Movement;value:SetValue;onChange?:(field:keyof SetValue,delta:number)=>void}) {
 return <Box testID="c-workout-active" style={[s.well,{marginTop:t.space.xs,marginBottom:t.space.md}]}>
   <Stepper field="reps" value={value.reps} min={movement.repsMin} max={movement.repsMax} step={1} onChange={d=>onChange?.('reps',d)}/>
   <View style={s.smallGap}><Stepper field="load" value={value.loadKg} min={movement.loadMinKg} max={movement.loadMaxKg} step={movement.loadStepKg} onChange={d=>onChange?.('loadKg',d)}/></View>
   <Txt role="metaMd" tone="secondary" style={s.smallGap}>{'The target is a guide.\nRecord what you did.'}</Txt>
 </Box>;
}
export function SetRow({movement,index,value,active=false,fresh=false,children,testID}:{movement:Movement;index:number;value?:SetValue;active?:boolean;fresh?:boolean;children?:React.ReactNode;testID?:string}) {
 return <MarginRow ruled word="Set" value={index} gutterState={active?'current':value?'done':'muted'} testID={testID} label={children?undefined:`Set ${index}. ${value?`${value.reps} reps at ${value.loadKg} kilograms. Confirmed.`:`Target ${movement.repsTarget} at ${movement.loadLabel}.`}`}>
   <View style={s.row}><View style={s.copy}><Mark fresh={fresh} active={!!value} role={value?'entryMd':'entrySm'} tone={value?'primary':'tertiary'}>{value?setText(value,movement.id):`Target ${movement.repsTarget} × ${movement.loadLabel}`}</Mark>{value&&<Txt role="metaMd" tone="secondary" style={s.detail}>Monday {movement.last.reps} × {movement.last.loadLabel}</Txt>}</View><Tick state={value?'checked':active?'current':'empty'} fresh={fresh}/></View>
   {children}
 </MarginRow>;
}
function Chevron({open}:{open:boolean}) {
 const {reducedMotion}=useMargin();const angle=useSharedValue(open?t.motion.rotation.disclosure:t.space.none);
 useEffect(()=>{angle.value=withTiming(open?t.motion.rotation.disclosure:t.space.none,{duration:reducedMotion?t.motion.duration.instant:t.motion.duration.expand,easing:open?easingOut:easingStandard});},[open,reducedMotion,angle]);
 const animation=useAnimatedStyle(()=>({transform:[{rotate:`${angle.value}deg`}]}));
 return <Animated.View style={[{width:t.render.planChevronWidth,marginTop:t.space.xxs},animation]}><Icon name="chevron" size={t.size.iconSm} color={t.role.icon.muted}/></Animated.View>;
}
export function DayRow({day,number,title,detail,session=true,current=false,done=false,changed=false,open=false,onPress,children,testID,visualState='default'}:React.PropsWithChildren<{day:string;number:number;title:string;detail?:string;session?:boolean;current?:boolean;done?:boolean;changed?:boolean;open?:boolean;onPress?:()=>void;testID?:string;visualState?:ControlState}>) {
 const [focus,setFocus]=useState(false);
 const body=<View style={s.row}><View style={s.copy}>{changed?<Mark role="titleMd">{title}</Mark>:<Txt role={session?'titleMd':'bodyMd'} tone={session?'primary':'tertiary'}>{title}</Txt>}{!!detail&&<Txt role="metaMd" tone="secondary" style={s.detail}>{detail}</Txt>}</View>{done&&<Tick small state="checked"/>}{session&&<Chevron open={open}/>}</View>;
 return <MarginRow word={day} value={number} gutterState={current?'current':session?'default':'muted'} ruled testID={testID}>
   {session?<Pressable accessibilityRole="button" accessibilityState={{expanded:open}} accessibilityLabel={`${day} ${number}. ${title}. ${detail??''}`} onPress={onPress} onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)} style={({pressed})=>[{minHeight:t.size.touchMin,backgroundColor:pressed||visualState==='pressed'?t.role.surface.pressed:undefined},(focus||visualState==='focus')&&focusStyle]}>{body}</Pressable>:body}
   <Disclosure open={open}>{children&&<View style={s.well}>{children}</View>}</Disclosure>
 </MarginRow>;
}
export function DraftPanel({draftKey,state,started=false,onApply,onDismiss,onUndo,onReopen,fresh=false,testID,afterSection=false}:{draftKey:DraftKey;state:DraftState;started?:boolean;onApply?:()=>void;onDismiss?:()=>void;onUndo?:()=>void;onReopen?:()=>void;fresh?:boolean;testID?:string;afterSection?:boolean}) {
 const {stacked}=useMargin();const d=F.coach.drafts[draftKey],base=testID??`c-coach-draft-${draftKey}`;
 if(state==='hidden')return null;
 if(state==='dismissed')return <Content style={s.footerGap}><Txt role="metaMd" tone="secondary">{d.dismissed}</Txt><Button label="Review draft" kind="text" testID={`${base}-reopen`} onPress={onReopen}/></Content>;
 const parts=d.to.split(' · ');
 return <Box testID={base} style={{borderWidth:t.border.control,borderColor:t.role.line.selected,borderRadius:t.radius.sm,borderCurve:'continuous',padding:t.space.md,paddingBottom:t.space.lg,marginHorizontal:t.space.lg,marginTop:afterSection?t.space.none:t.space.xs,marginBottom:t.space.xxl,backgroundColor:t.role.surface.raised}}>
   <Txt role="titleMd">{d.title}</Txt>
   <View style={{gap:t.space.xs,marginTop:t.space.sm}}>{['Was','Now'].map((label,i)=><View key={label} style={{flexDirection:stacked?'column':'row',gap:stacked?t.space.none:t.space.xs}}><Txt role="labelSm" tone="secondary" style={{width:stacked?undefined:t.render.draftLabelWidth,paddingTop:t.space.xxs,flexShrink:0}}>{label}</Txt><View style={s.copy}>{i===0?<Txt role="entrySm" tone="tertiary" style={{textDecorationLine:'line-through'}}>{d.from}</Txt>:<><Mark active={state==='applied'} fresh={fresh}>{parts[0]}</Mark><Txt role="entryMd">{parts.slice(1).join(' · ')}</Txt></>}</View></View>)}</View>
   <Txt role="metaMd" tone="secondary" style={s.gap}>{d.keep}</Txt>
   {state==='applied'?<><Txt style={s.footerGap} accessibilityRole="alert">{d.applied}</Txt><Button kind="text" label="Undo" testID={`${base}-undo`} onPress={onUndo} disabled={started}/>{started&&<StartedReason/>}</>:<><Button label={d.apply} testID={`${base}-apply`} onPress={onApply} disabled={started} style={{marginTop:t.space.md}}/>{started&&<StartedReason/>}<Button kind="text" label={d.dismiss} testID={`${base}-dismiss`} onPress={onDismiss}/></>}
 </Box>;
}
export function StartedReason(){return <Txt role="metaMd" tone="secondary" style={s.smallGap}>You've started this workout. Changes apply from your next session.</Txt>;}
export function ConversationEntry({entry,index,testID,endsSection=false}:{entry:Entry;index:number;testID?:string;endsSection?:boolean}) {
 const coach=entry.speaker==='coach',short=coach&&entry.text.length<=100;
 return <MarginRow compact pin={coach} word={coach?'Coach':'You'} value={entry.time} gutterState="speaker" testID={testID??`c-coach-entry-${index}`} label={`${coach?'Coach':'You'}, ${entry.time}: ${entry.text}`} style={{minHeight:t.size.rowLogMin,marginBottom:endsSection?t.space.none:t.space.lg}}><Txt role={short?'noteMd':'bodyMd'} tone={short?'note':'primary'}>{entry.text}</Txt></MarginRow>;
}
export function Compose({value,onChange,onSend,testID='c-coach-compose',forceFocus=false}:{value:string;onChange?:(s:string)=>void;onSend?:()=>void;testID?:string;forceFocus?:boolean}) {
 const [focused,setFocused]=useState(false);const frame=useFrame<TextInput>(testID);const env=useMargin();
 return <View style={{flexDirection:'row',borderWidth:focused||forceFocus?t.border.focus:t.border.control,borderColor:focused||forceFocus?t.role.line.focus:t.role.line.control,borderRadius:t.radius.sm,borderCurve:'continuous',backgroundColor:t.role.surface.well,padding:t.space.xs,marginTop:t.space.xl}}>
  <TextInput {...frame} testID={testID} value={value} onChangeText={onChange} placeholder="Write a note to your coach" accessibilityLabel="Write a note to your coach" placeholderTextColor={t.role.text.tertiary} maxLength={500} multiline returnKeyType="send" blurOnSubmit onSubmitEditing={onSend} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} maxFontSizeMultiplier={t.a11y.maxScaleBody} style={[textStyle('bodyMd',env.webLarge),{flex:1,minWidth:t.space.none,minHeight:t.size.composeMinHeight,maxHeight:t.size.composeMaxHeight,padding:t.space.none,textAlignVertical:'top'}]}/>
  <Pressable testID={testID==='c-coach-compose'?'c-coach-send':`${testID}-send`} accessibilityRole="button" accessibilityLabel="Send note" accessibilityState={{disabled:!value.trim()}} disabled={!value.trim()} onPress={onSend} style={{width:t.size.sendButton,height:t.size.sendButton,alignItems:'center',justifyContent:'center'}}><Icon name="up" color={value.trim()?t.role.icon.selected:t.role.icon.disabled}/></Pressable>
 </View>;
}
export function Segments({metric,onChange,prefix='c-progress-metric-',visualState='default'}:{metric:Metric;onChange?:(m:Metric)=>void;prefix?:string;visualState?:ControlState}) {
 return <View accessibilityRole="tablist" style={{flexDirection:'row',borderWidth:t.border.control,borderColor:t.role.line.control,borderRadius:t.radius.xs,borderCurve:'continuous',overflow:'hidden',marginBottom:t.space.md}}>{(['sets','minutes','sessions'] as const).map((k,i)=><Segment key={k} label={k[0].toUpperCase()+k.slice(1)} selected={k===metric} onPress={()=>onChange?.(k)} last={i===2} testID={prefix+k} visualState={visualState}/>)}</View>;
}
function Segment({label,selected,onPress,last,testID,visualState}:{label:string;selected:boolean;onPress:()=>void;last:boolean;testID:string;visualState:ControlState}) {
 const frame=useFrame<View>(testID);const [focus,setFocus]=useState(false);
 return <Pressable {...frame} testID={testID} accessibilityRole="tab" accessibilityState={{selected}} onPress={onPress} onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)} style={({pressed})=>[{flex:1,minHeight:t.size.touchMin,justifyContent:'center',alignItems:'center',borderRightWidth:last?t.space.none:t.border.control,borderRightColor:t.role.line.control,backgroundColor:selected?t.role.surface.selected:pressed||visualState==='pressed'?t.role.surface.pressed:t.role.surface.page},(focus||visualState==='focus')&&focusStyle]}>
   {selected&&<View pointerEvents="none" style={{position:'absolute',top:t.space.none,right:t.space.none,bottom:t.space.none,left:t.space.none,borderWidth:t.border.selected,borderColor:t.role.line.selected}}/>}<Txt role="labelMd" tone={selected?'accent':'secondary'}>{label}</Txt>
 </Pressable>;
}
export function TallyRow({month,day,value,metric,current=false,open=false,onPress,entries,testID,visualState='default'}:{month:string;day:string;value:number;metric:Metric;current?:boolean;open?:boolean;onPress?:()=>void;entries?:readonly string[];testID?:string;visualState?:ControlState}) {
 const [trackWidth,setTrackWidth]=useState(0),[focus,setFocus]=useState(false);
 const max={sets:t.chart.scaleMaxSets,minutes:t.chart.scaleMaxMinutes,sessions:t.chart.scaleMaxSessions}[metric];
 const fraction=value?Math.min(1,Math.max(t.chart.minBarPct/100,value/max)):0;
 return <MarginRow compact word={month} value={day} gutterState={current?'current':'default'} testID={testID} style={{minHeight:t.size.tallyRowHeight}}>
   <Pressable accessibilityRole="button" accessibilityLabel={`Week of ${month} ${day}: ${value} ${metric}`} accessibilityState={{expanded:open}} onPress={onPress} onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)} style={({pressed})=>[{flexDirection:'row',alignItems:'center',gap:t.space.xs,minHeight:t.size.tallyRowHeight,backgroundColor:pressed||visualState==='pressed'?t.role.surface.pressed:undefined},(focus||visualState==='focus')&&focusStyle]}>
     <View onLayout={e=>setTrackWidth(e.nativeEvent.layout.width)} style={{height:t.size.tallyBarHeight,backgroundColor:t.role.chart.track,borderRadius:t.radius.bar,borderCurve:'continuous',flex:1,overflow:'hidden'}}><View style={{height:'100%',width:trackWidth*fraction,backgroundColor:current?t.role.chart.bar:t.role.chart.barPast,borderRadius:t.radius.bar,borderCurve:'continuous'}}/></View><Txt role="entryMd" style={{width:t.size.tallyValueWidth,textAlign:'right'}}> {value}</Txt>
   </Pressable>
   {current&&<Txt role="metaMd" tone="secondary">This week so far</Txt>}
   <Disclosure open={open}><View style={s.well}>{entries?.map((e,i)=><Txt key={i} role="metaMd" style={s.smallGap}>{e}</Txt>)}</View></Disclosure>
 </MarginRow>;
}
