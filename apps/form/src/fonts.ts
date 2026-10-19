import { useFonts } from 'expo-font';

const fonts = {
  Bricolage700: require('../assets/fonts/Bricolage700.ttf'),
  AtkinsonNext400: require('../assets/fonts/AtkinsonNext400.ttf'),
  AtkinsonNext600: require('../assets/fonts/AtkinsonNext600.ttf'),
  AtkinsonNext700: require('../assets/fonts/AtkinsonNext700.ttf'),
  BarlowSemiCondensed600: require('../assets/fonts/BarlowSemiCondensed600.ttf'),
  BarlowSemiCondensed700: require('../assets/fonts/BarlowSemiCondensed700.ttf'),
  Atkinson400: require('../assets/fonts/Atkinson400.ttf'),
  Atkinson700: require('../assets/fonts/Atkinson700.ttf'),
  SchibstedGrotesk_400Regular: require('../assets/fonts/SchibstedGrotesk_400Regular.ttf'),
  SchibstedGrotesk_500Medium: require('../assets/fonts/SchibstedGrotesk_500Medium.ttf'),
  SchibstedGrotesk_600SemiBold: require('../assets/fonts/SchibstedGrotesk_600SemiBold.ttf'),
  SchibstedGrotesk_700Bold: require('../assets/fonts/SchibstedGrotesk_700Bold.ttf'),
  SchibstedGrotesk_800ExtraBold: require('../assets/fonts/SchibstedGrotesk_800ExtraBold.ttf'),
  SchibstedGrotesk_900Black: require('../assets/fonts/SchibstedGrotesk_900Black.ttf'),
  SchibstedGrotesk_500Medium_Italic: require('../assets/fonts/SchibstedGrotesk_500Medium_Italic.ttf'),
  IBMPlexMono_400Regular: require('../assets/fonts/IBMPlexMono_400Regular.ttf'),
  IBMPlexMono_500Medium: require('../assets/fonts/IBMPlexMono_500Medium.ttf'),
  IBMPlexMono_600SemiBold: require('../assets/fonts/IBMPlexMono_600SemiBold.ttf'),
};

export function useFormFonts(): boolean {
  const [loaded, error] = useFonts(fonts);
  if (error) throw error;
  return loaded;
}
