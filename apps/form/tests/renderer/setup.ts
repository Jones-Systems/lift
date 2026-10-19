import { afterEach, beforeEach, jest } from '@jest/globals';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

beforeEach(() => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Renderer tests must use the injected synthetic transport');
  });
});

afterEach(() => { jest.restoreAllMocks(); });
