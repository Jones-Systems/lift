module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/tests/renderer/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/tests/renderer/setup.ts'],
  cache: false,
  resolver: '<rootDir>/tests/renderer/resolver.cjs',
  moduleNameMapper: {
    '^react-native-worklets$': '<rootDir>/node_modules/react-native-worklets/src/index.ts',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|react-native-svg))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
};
