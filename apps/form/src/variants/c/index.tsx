import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, Platform, ScrollView, StatusBar, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { VariantProps } from '../../types';
import { Box, TopBar } from './primitives';
import { HomeArea, ResetSheet, Tabs, WebStatus } from './navigation';
import { Today, Plan, Workout, Coach, Progress, WorkoutRail } from './screens';
import { Showcase } from './showcase';
import { MarginEnvironment, t, useMarginEnvironment } from './theme';
import { initialState as createInitial, reducer, confirmedCount, movements, type Action } from './model';
import { fixtures as F } from './generatedfixtures';
import { installCaptureHook, captureMarginFrames } from './capture';

export default function VariantApp({initialScreen='today',initialState='default',showcase=false,onScreenChange}:VariantProps) {
 const [state,dispatch]=useReducer(reducer,undefined,()=>createInitial(initialScreen,initialState));
 const [width,setWidth]=useState<number>(t.render.phoneWidth);const [scrolled,setScrolled]=useState(false);
 const env=useMarginEnvironment(width),insets=useSafeAreaInsets();
 const scroll=useRef<ScrollView>(null);
 const scrollOffset=useRef(0),pendingEntry=useRef<string|null>(null);
 useEffect(()=>{installCaptureHook();},[]);
 const act=useCallback((action:Action)=>{
   const next=reducer(state,action);if(next===state)return;
   if((action.type==='send'&&state.compose.trim())||action.type==='chip')pendingEntry.current=`c-coach-entry-${state.entries.length+F.coach.opening.length}`;
   dispatch(action);
   if(action.type==='tab'){onScreenChange?.(action.screen);setScrolled(false);scroll.current?.scrollTo({y:0,animated:false});}
   if(['next','prev','save','reset-confirm'].includes(action.type)||action.type==='skip')scroll.current?.scrollTo({y:0,animated:false});
   if(action.type==='confirm'){
     const movement=movements(state)[state.movementIndex],n=(state.confirmed[movement.id]?.length??0)+1;
     AccessibilityInfo.announceForAccessibility(`Set ${n} confirmed: ${state.draftSet.reps} reps at ${state.draftSet.loadKg} kilograms.`);
   }
   if(action.type==='undo-set')AccessibilityInfo.announceForAccessibility(`Set ${state.confirmed[movements(state)[state.movementIndex].id]?.length??0} removed.`);
   if(action.type==='undo-notice'||action.type==='draft'&&action.operation==='undo')AccessibilityInfo.announceForAccessibility('Undone.');
   if(action.type==='draft'&&action.operation==='apply')AccessibilityInfo.announceForAccessibility(F.coach.drafts[action.key].applied);
   if(Platform.OS==='ios'&&(action.type==='confirm'||action.type==='save'||action.type==='draft'&&action.operation==='apply'))void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
 },[state,onScreenChange]);
 const Screen={today:Today,plan:Plan,workout:Workout,coach:Coach,progress:Progress}[state.screen];
 return <MarginEnvironment.Provider value={env}><Box testID={showcase?'c-showcase-screen':`c-${state.screen}-screen`} onLayout={e=>setWidth(e.nativeEvent.layout.width)} style={{flex:1,backgroundColor:t.role.surface.page,paddingTop:Platform.OS==='web'?t.space.none:insets.top}}>
   <StatusBar barStyle="dark-content"/><WebStatus/><TopBar screen={showcase?'showcase':state.screen} scrolled={scrolled} system={showcase}/>
   <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined} style={{flex:1}}>
    <ScrollView ref={scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" onScroll={e=>{scrollOffset.current=e.nativeEvent.contentOffset.y;setScrolled(scrollOffset.current>0);}} onContentSizeChange={()=>{const id=pendingEntry.current;if(!id)return;pendingEntry.current=null;requestAnimationFrame(()=>{void captureMarginFrames().then(({elements})=>{const entry=elements.find(e=>e.a11y_id===id),bar=elements.find(e=>e.a11y_id==='c-coach-topbar');if(entry&&bar){const scale=bar.frame_pt[2]/width;scroll.current?.scrollTo({y:Math.max(0,scrollOffset.current+(entry.frame_pt[1]-bar.frame_pt[1]-bar.frame_pt[3])/scale-t.space.xl),animated:false});}});});}} scrollEventThrottle={t.motion.duration.tick} contentContainerStyle={{paddingBottom:t.layout.scrollBottomPad}}>
      {showcase?<Showcase/>:<Screen state={state} act={act}/>}
    </ScrollView>
    {!showcase&&state.screen==='workout'&&<WorkoutRail state={state} act={act}/>}
   </KeyboardAvoidingView>
   {!showcase&&<Tabs screen={state.screen} onChange={screen=>act({type:'tab',screen})}/>}<HomeArea/>
   <ResetSheet visible={state.sheet} count={confirmedCount(state)} onKeep={()=>act({type:'reset-close'})} onConfirm={()=>act({type:'reset-confirm'})}/>
 </Box></MarginEnvironment.Provider>;
}
