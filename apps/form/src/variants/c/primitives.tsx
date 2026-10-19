import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Platform, type TextProps, type ViewProps, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Rect } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { Icon, type IconName } from './assets/icons';
import { useFrame } from './capture';
import { t, textStyle, contentStyle, focusStyle, useMargin, easingOut, easingStandard, s, type TypeRole, type TextTone } from './theme';

export function Txt({ role='bodyMd', tone='primary', style, testID, tab=false, chrome=false, onLayout, ...props }: Omit<TextProps,'role'> & {role?:TypeRole; tone?:TextTone; tab?:boolean; chrome?:boolean}) {
  const env = useMargin();
  const frame = useFrame<Text>(testID);
  const display = role.startsWith('display') || role === 'figureLg';
  return <Text {...props} {...frame} onLayout={event=>{frame.onLayout();onLayout?.(event);}} testID={testID} allowFontScaling={!chrome} maxFontSizeMultiplier={tab ? t.a11y.maxScaleTab : display ? t.a11y.maxScaleDisplay : t.a11y.maxScaleBody} style={[textStyle(role, env.webLarge && !tab && !chrome),{color:t.role.text[tone]},style]} />;
}
export function Box({ testID, onLayout, ...props }: ViewProps) {
  const frame = useFrame<View>(testID);
  return <View {...props} {...frame} onLayout={event=>{frame.onLayout();onLayout?.(event);}} testID={testID} />;
}
export function Content({style,...props}:ViewProps) { const {stacked}=useMargin(); return <Box {...props} style={[contentStyle(stacked),style]} />; }
export function Section({heading,children,testID,style,stacked:forceStacked}:React.PropsWithChildren<{heading?:string;testID?:string;style?:StyleProp<ViewStyle>;stacked?:boolean}>) {
  const env=useMargin(); const stacked=forceStacked ?? env.stacked;
  return <Box testID={testID} style={[{marginBottom:t.layout.sectionGap},style]}>
    <View pointerEvents="none" accessible={false} importantForAccessibility="no" style={{position:'absolute',top:t.space.none,bottom:t.space.none,left:stacked?t.layout.stackedMarginRuleLeft:t.layout.ruleLeft,width:t.layout.ruleWidth,backgroundColor:t.role.line.margin}} />
    {heading && <View style={[contentStyle(stacked),{marginBottom:t.layout.sectionHeadingToBody}]}><Txt role="titleLg" accessibilityRole="header">{heading}</Txt></View>}
    {children}
  </Box>;
}
export function Header({screen,date,title,lead}: {screen:string;date:string;title:string;lead?:string}) {
  return <Box style={{paddingTop:t.layout.pageHeaderTop,paddingHorizontal:t.layout.screenInsetX,paddingBottom:t.layout.headerBottom}}>
    <Txt role="metaMd" tone="secondary" testID={`c-${screen}-${['coach','workout'].includes(screen)?'context':'date'}`}>{date}</Txt>
    <Txt role="displayXl" accessibilityRole="header" testID={`c-${screen}-title`} style={{marginTop:t.layout.dateToTitle}}>{title}</Txt>
    {!!lead && <Txt role="bodyLead" tone="secondary" testID={`c-${screen}-lead`} style={{marginTop:t.layout.titleToLead}}>{lead.replace(/<br\s*\/?\s*>/g,'\n')}</Txt>}
  </Box>;
}
export function TopBar({screen,scrolled=false,system=false}: {screen:string;scrolled?:boolean;system?:boolean}) {
 return <Box testID={`c-${screen}-topbar`} style={{height:t.layout.topBarHeight,paddingHorizontal:t.layout.screenInsetX,flexDirection:'row',alignItems:'center',justifyContent:'space-between',backgroundColor:t.role.surface.bar,borderBottomColor:t.role.line.ruling,borderBottomWidth:scrolled?t.border.hairline:t.space.none}}>
   <Txt role="wordmark" accessibilityRole={screen==='today'?'header':undefined}>Form</Txt>{system&&<Txt role="labelSm">System</Txt>}
 </Box>;
}
export function Mark({children,role='entryMd',active=true,fresh=false,testID,tone='primary',phase}: {children:string;role?:TypeRole;active?:boolean;fresh?:boolean;testID?:string;tone?:TextTone;phase?:'hidden'|'drawing'|'shown'|'receding'}) {
 const env=useMargin();const [box,setBox]=useState({width:0,height:0});
 const progress=useSharedValue(phase==='receding'?1:active&&!fresh?1:0);
 const lineHeight=env.webLarge?t.accessibilityType[role].line_height:t.type[role].lineHeight;
 useEffect(()=>{
  if((fresh||phase==='drawing')&&active)progress.value=t.motion.scale.swipeFrom;
  if(phase==='receding')progress.value=1;
  const visible=active&&phase!=='hidden'&&phase!=='receding';
  progress.value=withTiming(visible?1:0,{duration:env.reducedMotion?t.motion.duration.reducedFade:visible?t.motion.duration.swipe:t.motion.duration.tick,easing:visible?easingOut:easingStandard});
 },[active,fresh,phase,env.reducedMotion,progress]);
 const animation=useAnimatedStyle(()=>({opacity:env.reducedMotion?progress.value:1,transform:[{scaleX:env.reducedMotion?1:progress.value}]}));
 return <View style={{alignSelf:'flex-start',maxWidth:'100%'}}>
   <Animated.View pointerEvents="none" accessible={false} importantForAccessibility="no" style={[{position:'absolute',left:-t.size.swipeOverhangX,top:lineHeight*t.mark.swipeTop,width:box.width+t.size.swipeOverhangX*t.space.hair,height:lineHeight*(t.mark.swipeBottom-t.mark.swipeTop),transformOrigin:'left center'},animation]}>
    <View style={{transform:[{skewX:`${t.mark.swipeSkewDegrees}deg`}],width:'100%',height:'100%'}}><Svg width="100%" height="100%"><Rect width="100%" height="100%" fill={t.role.mark.highlight}/></Svg></View>
   </Animated.View>
   <Txt role={role} tone={tone} testID={testID} onLayout={e=>setBox(e.nativeEvent.layout)} onTextLayout={e=>{const first=e.nativeEvent.lines[0];if(first)setBox({width:first.width,height:first.height});}}>{children}</Txt>
 </View>;
}

export type GutterState = 'default'|'current'|'done'|'muted'|'speaker'|'disabled';
export function Gutter({word,value,state='default',speaker=false,compact=false,mark=false}: {word?:string;value?:React.ReactNode;state?:GutterState;speaker?:boolean;compact?:boolean;mark?:boolean}) {
 const {stacked}=useMargin();
 const tone:TextTone=state==='current'||state==='speaker'?'accent':state==='muted'?'tertiary':state==='disabled'?'disabled':'secondary';
 const valueTone:TextTone=speaker?'tertiary':state==='current'?'accent':state==='muted'?'tertiary':state==='disabled'?'disabled':'primary';
 return <View style={stacked ? {flexDirection:'row',alignItems:'baseline',gap:t.space.xs,marginLeft:t.layout.stackedMarginContentLeft,marginBottom:t.space.xs} : {position:'absolute',left:t.layout.gutterLeft,width:t.layout.gutterWidth,top:compact?t.space.none:t.space.sm}}>
   {!!word&&<Txt role="labelSm" tone={tone}>{word}</Txt>}
   {value!==undefined&&<View style={{marginTop:stacked||compact?t.space.none:speaker?t.space.xxs:t.space.hair}}>{mark?<Mark role="figureGutter" fresh tone={valueTone}>{String(value)}</Mark>:<Txt role={speaker?'entrySm':'figureGutter'} tone={valueTone}>{value}</Txt>}{state==='current'&&!stacked&&<View style={{width:t.size.tabIndicatorWidth,height:t.size.currentDayUnderline,marginTop:t.space.hair,backgroundColor:t.role.line.selected}}/>}</View>}
 </View>;
}
export function MarginRow({word,value,gutterState='default',children,ruled=false,cue=false,testID,label,style,compact=false,pin=false,marked=false}:React.PropsWithChildren<{word?:string;value?:React.ReactNode;gutterState?:GutterState;ruled?:boolean;cue?:boolean;testID?:string;label?:string;style?:StyleProp<ViewStyle>;compact?:boolean;pin?:boolean;marked?:boolean}>) {
 const {stacked}=useMargin();
 return <Box testID={testID} accessible={!!label} accessibilityLabel={label} style={[{minHeight:cue?t.space.xxl:compact?t.space.none:t.size.rowLogMin,paddingTop:cue?t.space.xxs:compact?t.space.none:t.space.sm,paddingBottom:cue?t.space.xxs:compact?t.space.none:t.render.rowPadBottom},style]}>
   {(word||value!==undefined)&&<Gutter word={word} value={value} state={gutterState} speaker={gutterState==='speaker'} compact={compact||cue} mark={marked}/>}
   <Content>{children}</Content>
   {pin&&<View pointerEvents="none" accessible={false} importantForAccessibility="no" style={{position:'absolute',left:stacked?t.space.md:t.render.pinLeft,top:t.render.pinTop,width:t.size.notePin,height:t.size.notePin,backgroundColor:t.role.line.margin}}/>}
   {ruled&&<View pointerEvents="none" accessible={false} importantForAccessibility="no" style={{position:'absolute',left:stacked?t.layout.stackedMarginContentLeft:t.layout.contentLeft,right:t.layout.contentRightInset,bottom:t.space.none,height:t.border.hairline,backgroundColor:t.role.line.ruling}}/>}
 </Box>;
}
export type ControlState='default'|'pressed'|'disabled'|'focus';
export function Button({label,onPress,testID,kind='primary',disabled=false,caution=false,style,visualState='default',icon}: {label:string;onPress?:()=>void;testID?:string;kind?:'primary'|'secondary'|'text'|'chip';disabled?:boolean;caution?:boolean;style?:StyleProp<ViewStyle>;visualState?:ControlState;icon?:IconName}) {
 const {reducedMotion}=useMargin();const [focus,setFocus]=useState(false);const [pressed,setPressed]=useState(false);
 const scale=useSharedValue(1);const frame=useFrame<View>(testID);
 const down=pressed||visualState==='pressed';const off=disabled||visualState==='disabled';
 useEffect(()=>{scale.value=withTiming(down&&!reducedMotion&&kind!=='text'?t.motion.scale.press:1,{duration:t.motion.duration.press,easing:easingOut});},[down,reducedMotion,kind,scale]);
 const motion=useAnimatedStyle(()=>({transform:[{scale:scale.value}]}));
 const primary=kind==='primary',secondary=kind==='secondary',text=kind==='text';
 const color=off?(primary?t.role.action.primaryLabelDisabled:t.role.text.disabled):caution?t.role.text.error:primary?t.role.action.primaryLabel:kind==='chip'?t.role.text.primary:t.role.text.accent;
 return <Animated.View style={[{alignSelf:text?'flex-start':'stretch'},style,motion]}>
  <Pressable {...frame} testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled:off}} disabled={off} onPress={onPress} onPressIn={()=>setPressed(true)} onPressOut={()=>setPressed(false)} onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)} style={[{
    minHeight:primary?t.size.buttonPrimaryHeight:secondary?t.size.buttonSecondaryHeight:t.size.touchMin,minWidth:t.size.touchMin,
    paddingHorizontal:text?t.space.none:kind==='chip'?t.space.sm:secondary?t.space.md:t.space.lg,paddingVertical:primary||secondary?t.space.sm:t.space.xs,
    borderRadius:text?t.radius.xs:kind==='chip'?t.radius.xs:t.radius.sm,borderCurve:'continuous',
    borderWidth:secondary||kind==='chip'?t.border.control:t.space.none,
    borderColor:off?t.role.text.disabled:caution?t.role.text.error:secondary?t.role.action.secondaryBorder:t.role.line.control,
    backgroundColor:primary?(off?t.role.action.primaryBgDisabled:down?t.role.action.primaryBgPressed:t.role.action.primaryBg):down?(caution?t.role.surface.error:t.role.surface.pressed):undefined,
    justifyContent:'center',alignItems:text?'flex-start':'center',flexDirection:'row',gap:t.space.xxs,
  },(focus||visualState==='focus')&&focusStyle]}>
    {icon&&<Icon name={icon} size={t.size.iconSm} color={color}/>}
    <Txt role={primary||secondary?'labelLg':'labelMd'} style={{color,textAlign:text?'left':'center',textDecorationLine:text&&!off?'underline':'none',flexShrink:1}}>{label}</Txt>
  </Pressable>
 </Animated.View>;
}
export function Note({children,testID,startsSection=false}:React.PropsWithChildren<{testID?:string;startsSection?:boolean}>) {
 return <MarginRow compact pin testID={testID} label={`Coach note: ${children}`} style={{marginTop:startsSection?t.space.none:t.space.lg,minHeight:startsSection?t.size.rowLogMin:t.space.none}}><Txt role="noteMd" tone="note">{children}</Txt></MarginRow>;
}
export function Notice({text,undo,testID}: {text:string;undo?:()=>void;testID?:string}) {
 const {reducedMotion}=useMargin(); const value=useSharedValue(0);
 useEffect(()=>{value.value=0;value.value=withTiming(1,{duration:reducedMotion?t.motion.duration.reducedFade:t.motion.duration.swipe,easing:easingOut});},[text,reducedMotion,value]);
 const animation=useAnimatedStyle(()=>({opacity:value.value,transform:[{translateY:reducedMotion?t.space.none:(1-value.value)*t.motion.distance.noticeFrom}]}));
 return <Content style={{marginTop:t.space.sm,marginBottom:t.space.md}}><Animated.View style={animation}><Txt accessibilityRole="alert">{text}</Txt>{undo&&<Button kind="text" label="Undo" testID={testID} onPress={undo}/>}</Animated.View></Content>;
}
export function Disclosure({open,children}:React.PropsWithChildren<{open:boolean}>) {
 const {reducedMotion}=useMargin();const [shown,setShown]=useState(open);const opacity=useSharedValue(open?1:0);
 useEffect(()=>{
  if(open)setShown(true);
  opacity.value=withTiming(open?1:0,{duration:reducedMotion?t.motion.duration.reducedFade:t.motion.duration.expand,easing:open?easingOut:easingStandard},finished=>{if(finished&&!open)scheduleOnRN(setShown,false);});
 },[open,reducedMotion,opacity]);
 const motion=useAnimatedStyle(()=>({opacity:opacity.value}));
 return shown?<Animated.View style={motion}>{children}</Animated.View>:null;
}
