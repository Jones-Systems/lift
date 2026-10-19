Pod::Spec.new do |s|
  s.name = 'FormStoreKit'
  s.version = '0.1.0'
  s.summary = 'Form StoreKit 2 proof bridge'
  s.description = 'Purchase and transaction proofs with explicit server delivery acknowledgment.'
  s.license = { :type => 'Proprietary' }
  s.author = 'Jones Systems'
  s.homepage = 'https://github.com/Jones-Systems/Form'
  s.source = { :git => 'https://github.com/Jones-Systems/Form.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'StoreKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
