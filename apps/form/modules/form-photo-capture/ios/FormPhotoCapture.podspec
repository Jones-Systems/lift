Pod::Spec.new do |s|
  s.name = 'FormPhotoCapture'
  s.version = '0.1.0'
  s.summary = 'Unqualified Form photo capability and lease boundary'
  s.description = 'Default-disabled camera source and opaque photo leases; native persistence is unqualified.'
  s.license = { :type => 'Proprietary' }
  s.author = 'Jones Systems'
  s.homepage = 'https://github.com/Jones-Systems/Form'
  s.source = { :git => 'https://github.com/Jones-Systems/Form.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'UIKit', 'ImageIO'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
