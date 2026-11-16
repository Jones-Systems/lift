import { createContextReviewRenderer } from '../features/training/context-review';
import { createSourcePlanDetailRenderer } from '../features/training/source-plan-detail';

export function createTrainingContextPresentation() {
  return Object.freeze({
    renderContextConfirmation: createContextReviewRenderer(),
    renderSourcePlanDetail: createSourcePlanDetailRenderer(),
  });
}
