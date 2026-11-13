import { createElement } from 'react';
import type { FormAccountAppProps } from '../../contract';
import { SourcePlanDetailScreen } from './SourcePlanDetailScreen';

export { SourcePlanDetailScreen };
export type SourcePlanDetailRenderer = NonNullable<FormAccountAppProps['renderSourcePlanDetail']>;

export function createSourcePlanDetailRenderer(): SourcePlanDetailRenderer {
  return context => createElement(SourcePlanDetailScreen, { context });
}
