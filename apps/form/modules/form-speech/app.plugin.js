const { withInfoPlist } = require('expo/config-plugins');

module.exports = function withFormSpeech(config, options = {}) {
  return withInfoPlist(config, configWithPlist => {
    const plist = configWithPlist.modResults;
    const microphone = options.microphoneUsageDescription ?? plist.NSMicrophoneUsageDescription
      ?? 'Allow Form to use your microphone for on-device transcription that you review.';
    const speech = options.speechRecognitionUsageDescription ?? plist.NSSpeechRecognitionUsageDescription
      ?? 'Allow Form to transcribe speech on this device for you to review before applying it.';
    for (const value of [microphone, speech]) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('Form speech requires nonempty microphone and speech permission descriptions.');
    }
    plist.NSMicrophoneUsageDescription = microphone;
    plist.NSSpeechRecognitionUsageDescription = speech;
    return configWithPlist;
  });
};
