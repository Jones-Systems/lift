Pod::Spec.new do |s|
  s.name = 'FormSpeech'
  s.version = '0.1.0'
  s.summary = 'Form on-device speech bridge'
  s.description = 'Ephemeral transcription through Apple Speech and AVFoundation.'
  s.license = { :type => 'Proprietary' }
  s.author = 'Jones Systems'
  s.homepage = 'https://github.com/Jones-Systems/Form'
  s.source = { :git => 'https://github.com/Jones-Systems/Form.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Speech', 'AVFoundation'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
