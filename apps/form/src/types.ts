export type ScreenId = 'today' | 'plan' | 'workout' | 'coach' | 'progress';
export type DirectionId = 'a' | 'b' | 'c';
export type VariantProps = {
  initialScreen?: ScreenId;
  initialState?: string;
  showcase?: boolean;
  onScreenChange?: (screen: string) => void;
};
