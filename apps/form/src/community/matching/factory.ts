import type { CommunityResources } from '../../api/community';
import { MatchingController, type MatchingResources } from './controller';

export type MatchingConsumerResources = MatchingResources & Pick<CommunityResources, 'createGroupController'>;

/** Owns one resource child for lifecycle observation, never the shared Community resource. */
export function createMatchingController(resources: MatchingConsumerResources): MatchingController {
  const lifetime = resources.createGroupController();
  try {
    return new MatchingController(resources, {
      isCurrent: () => !lifetime.getSnapshot().disposed,
      subscribe(listener) {
        const subscription = lifetime.subscribe(() => {
          if (lifetime.getSnapshot().disposed) listener();
        });
        return { remove() { subscription.remove(); lifetime.dispose(); } };
      },
    });
  } catch (error) {
    lifetime.dispose();
    throw error;
  }
}
