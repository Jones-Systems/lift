Pod::Spec.new do |s|
  s.name = 'FormHealth'
  s.version = '0.1.0'
  s.summary = 'Form read-only HealthKit lifecycle bridge'
  s.description = 'Read authorization lifecycle and explicitly bound complete-bucket query source; app ingestion remains gated.'
  s.license = { :type => 'Proprietary' }
  s.author = 'Jones Systems'
  s.homepage = 'https://github.com/Jones-Systems/Form'
  s.source = { :git => 'https://github.com/Jones-Systems/Form.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'HealthKit', 'UIKit', 'CryptoKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
