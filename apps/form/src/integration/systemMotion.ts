export type SystemMotionPort = {
  isReduceMotionEnabled(): Promise<boolean>;
  addEventListener(event: 'reduceMotionChanged', listener: (enabled: boolean) => void): { remove(): void };
};

// A change event is newer evidence than the initial asynchronous query.
export function observeSystemMotion(port: SystemMotionPort, receive: (enabled: boolean | null) => void): () => void {
  let active = true;
  let changed = false;
  receive(null);
  const subscription = port.addEventListener('reduceMotionChanged', enabled => {
    if (!active) return;
    changed = true;
    receive(enabled);
  });
  void port.isReduceMotionEnabled().then(enabled => {
    if (active && !changed) receive(enabled);
  }, () => {
    // Query failure keeps the static equivalent; a later system event can still resolve it.
  });
  return () => { active = false; subscription.remove(); };
}
