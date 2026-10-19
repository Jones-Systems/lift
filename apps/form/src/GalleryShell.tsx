import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { DirectionId, ScreenId, VariantProps } from './types';
import VariantA from './variants/a';
import VariantB from './variants/b';
import VariantC from './variants/c';

const VARIANTS: Record<DirectionId, ComponentType<VariantProps>> = { a: VariantA, b: VariantB, c: VariantC };
const DIRECTIONS: readonly DirectionId[] = ['a', 'b', 'c'];
const DIRECTION_NAMES: Record<DirectionId, string> = { a: 'Open Mat', b: 'Club Circuit', c: 'Margin' };
const SCREENS: readonly ScreenId[] = ['today', 'plan', 'workout', 'coach', 'progress'];
const SCREEN_LABELS: Record<ScreenId, string> = {
  today: 'Today',
  plan: 'Plan',
  workout: 'Workout',
  coach: 'Coach',
  progress: 'Progress',
};

export type Route = { direction: DirectionId | null; screen: ScreenId; showcase: boolean; state?: string };

const HUB: Route = { direction: null, screen: 'today', showcase: false };
const IS_WEB = Platform.OS === 'web' && typeof window !== 'undefined';

export function isDirectionId(value: unknown): value is DirectionId {
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value);
}

export function isScreenId(value: unknown): value is ScreenId {
  return typeof value === 'string' && (SCREENS as readonly string[]).includes(value);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

// Accepts web URLs (?direction=a&screen=today&showcase=1) and native deep links
// (form2directions://design-preview/a/today, or Expo Go's exp://host/--/design-preview/a/today).
// An unknown direction opens the hub; an unknown screen falls back to Today.
export function parseRoute(url: string | null | undefined): Route {
  if (!url) return HUB;
  const [beforeFragment] = url.split('#');
  const queryStart = beforeFragment.indexOf('?');
  const path = queryStart === -1 ? beforeFragment : beforeFragment.slice(0, queryStart);
  const query = new Map<string, string>();
  if (queryStart !== -1) {
    for (const pair of beforeFragment.slice(queryStart + 1).split('&')) {
      if (!pair) continue;
      const separator = pair.indexOf('=');
      const key = decode(separator === -1 ? pair : pair.slice(0, separator)).toLowerCase();
      if (!query.has(key)) query.set(key, decode(separator === -1 ? '' : pair.slice(separator + 1)));
    }
  }
  const deepLink = /(?:^|\/)design-preview\/([^/]+)(?:\/([^/]+))?/.exec(path);
  const direction = (query.get('direction') ?? deepLink?.[1] ?? '').toLowerCase();
  const segment = (deepLink?.[2] ?? '').toLowerCase();
  const screen = (query.get('screen') ?? segment).toLowerCase();
  const showcaseFlag = (query.get('showcase') ?? '').toLowerCase();
  if (!isDirectionId(direction)) return HUB;
  return {
    direction,
    screen: isScreenId(screen) ? screen : 'today',
    showcase: showcaseFlag === '1' || showcaseFlag === 'true' || segment === 'showcase',
    state: query.get('state') || undefined,
  };
}

export function routeQuery(route: Route): string {
  if (!route.direction) return '';
  const showcase = route.showcase ? '&showcase=1' : '';
  const state = route.state ? `&state=${encodeURIComponent(route.state)}` : '';
  return `?direction=${route.direction}&screen=${route.screen}${showcase}${state}`;
}

function initialWebRoute(): Route | null {
  return IS_WEB ? parseRoute(window.location.href) : null;
}

export function GalleryShell() {
  // Native waits for the launch URL so a deep link never flashes the hub.
  const [route, setRoute] = useState<Route | null>(initialWebRoute);
  const [mount, setMount] = useState(0);

  const show = useCallback((next: Route) => {
    setRoute(next);
    setMount((value) => value + 1);
  }, []);

  useEffect(() => {
    if (IS_WEB) {
      const onPopState = () => show(parseRoute(window.location.href));
      window.addEventListener('popstate', onPopState);
      return () => window.removeEventListener('popstate', onPopState);
    }
    let active = true;
    const launch = (url: string | null) => {
      if (active) setRoute((existing) => existing ?? parseRoute(url));
    };
    Linking.getInitialURL().then(launch, () => launch(null));
    const subscription = Linking.addEventListener('url', ({ url }) => show(parseRoute(url)));
    return () => {
      active = false;
      subscription.remove();
    };
  }, [show]);

  const open = useCallback(
    (next: Route) => {
      if (IS_WEB) window.history.pushState(null, '', routeQuery(next) || window.location.pathname);
      show(next);
    },
    [show],
  );

  const onScreenChange = useCallback(
    (screen: string) => {
      if (!IS_WEB || !route?.direction || !isScreenId(screen)) return;
      // Keep reload and share links on the visible screen without remounting the variant.
      window.history.replaceState(null, '', routeQuery({ ...route, screen, state: undefined }));
    },
    [route],
  );

  if (!route) return <View style={styles.fill} />;
  if (!route.direction) return <Hub onOpen={open} />;
  const Variant = VARIANTS[route.direction];
  return (
    <View style={styles.fill}>
      <Variant
        key={`${route.direction}:${route.screen}:${route.showcase ? 'showcase' : 'app'}:${mount}`}
        initialScreen={route.screen}
        initialState={route.state}
        showcase={route.showcase}
        onScreenChange={onScreenChange}
      />
    </View>
  );
}

function Hub({ onOpen }: { onOpen: (route: Route) => void }) {
  return (
    <SafeAreaView style={styles.hub}>
      <ScrollView contentContainerStyle={styles.hubContent}>
        <Text accessibilityRole="header" style={styles.hubTitle}>
          Form 2 directions
        </Text>
        <Text style={styles.hubNote}>Choose a direction to open its design system or one of its five screens.</Text>
        {DIRECTIONS.map((direction) => (
          <View key={direction} style={styles.direction}>
            <Text accessibilityRole="header" style={styles.directionTitle}>
              {direction.toUpperCase()} · {DIRECTION_NAMES[direction]}
            </Text>
            <View style={styles.choices}>
              <Choice
                label="Design system"
                onPress={() => onOpen({ direction, screen: 'today', showcase: true })}
              />
              {SCREENS.map((screen) => (
                <Choice
                  key={screen}
                  label={SCREEN_LABELS[screen]}
                  onPress={() => onOpen({ direction, screen, showcase: false })}
                />
              ))}
            </View>
          </View>
        ))}
        <View style={styles.direction}>
          <Text accessibilityRole="header" style={styles.directionTitle}>Original Form 2 resources</Text>
          <Text style={styles.hubNote}>The recovered UI system, component library and clickable app that informed these directions.</Text>
          <View style={styles.choices}>
            <Choice label="Figma UI system" onPress={() => void Linking.openURL('https://www.figma.com/design/tKZECRfc60rfdO0XMdLlsB')} />
            <Choice label="Original components" onPress={() => void Linking.openURL('https://www.figma.com/design/tKZECRfc60rfdO0XMdLlsB?node-id=1-4')} />
            <Choice label="Clickable Today" onPress={() => void Linking.openURL('https://www.figma.com/design/tKZECRfc60rfdO0XMdLlsB?node-id=4-30')} />
            <Choice label="Expanded variations" onPress={() => void Linking.openURL('https://www.figma.com/design/pomD1Yc3w7GSs25gpqBsfQ')} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Choice({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.choice, pressed && styles.choicePressed]}
    >
      <Text style={styles.choiceLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#FFFFFF' },
  hub: { flex: 1, backgroundColor: '#F6F6F4' },
  hubContent: { padding: 24, gap: 20, maxWidth: 720, width: '100%', alignSelf: 'center' },
  hubTitle: { fontSize: 28, fontFamily: 'AtkinsonNext700', color: '#1A1A1A' },
  hubNote: { fontSize: 16, lineHeight: 22, fontFamily: 'AtkinsonNext400', color: '#4A4A4A' },
  direction: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: '#FFFFFF' },
  directionTitle: { fontSize: 20, fontFamily: 'AtkinsonNext600', color: '#1A1A1A' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C9C9C4',
    backgroundColor: '#FFFFFF',
  },
  choicePressed: { backgroundColor: '#EDEDE9' },
  choiceLabel: { fontSize: 16, fontFamily: 'AtkinsonNext400', color: '#1A1A1A' },
});
