const nativeResolver = require('@react-native/jest-preset/jest/resolver');
const workletsResolver = require('react-native-worklets/jest/resolver');

module.exports = (request, options) => workletsResolver(request, {
  ...options,
  defaultResolver: (name, next) => nativeResolver(name, {
    ...next,
    defaultResolver: options.defaultResolver,
  }),
});
