import type { CaptureLease, CapturePermission, CapturePermissionOperation, CaptureReadiness, CaptureScope, PhotoCaptureGuidancePort, PhotoCapturePort } from './types';

type BoundPhotoCapturePort = Readonly<PhotoCapturePort & PhotoCaptureGuidancePort>;
const missingPermission = (): CapturePermission => ({ status: 'unavailable', reason: 'native_module_missing' });
export const UNAVAILABLE_PHOTO_CAPTURE_PORT: BoundPhotoCapturePort = Object.freeze({
  availability: async (): Promise<CaptureReadiness> => ({ ready: false, reason: 'native_module_missing' }),
  acquire: async () => { throw new Error('native_capture_unqualified'); },
  capture: async () => { throw new Error('native_capture_unqualified'); },
  cancel: async (lease: CaptureLease) => ({ leaseId: lease.leaseId, status: 'unknown' as const }),
  permissionStatus: async () => missingPermission(),
  requestPermission: async (_scope: CaptureScope, requestId: string) => ({ ...missingPermission(), requestId }),
  permissionRetirement: (operation: CapturePermissionOperation) => ({ operation, status: 'not_requested' as const }),
  preview: async () => { throw new Error('native_capture_unqualified'); },
  retake: async () => { throw new Error('native_capture_unqualified'); },
  invalidatePreviews: (lease: CaptureLease) => ({ leaseId: lease.leaseId, status: 'unknown' as const }),
});

// WS01 owns binding FormPhotoCapture in src/native/runtime.ts; importing this seam never probes a device.
export function createPhotoCapturePort(module: PhotoCapturePort | null): BoundPhotoCapturePort {
  if (!module || module === UNAVAILABLE_PHOTO_CAPTURE_PORT) return UNAVAILABLE_PHOTO_CAPTURE_PORT;
  return Object.freeze({
    ...(module.synthetic === true ? { synthetic: true as const } : {}),
    availability: module.availability.bind(module),
    acquire: module.acquire.bind(module),
    capture: module.capture.bind(module),
    cancel: module.cancel.bind(module),
    permissionStatus: module.permissionStatus?.bind(module) ?? UNAVAILABLE_PHOTO_CAPTURE_PORT.permissionStatus,
    requestPermission: module.requestPermission?.bind(module) ?? UNAVAILABLE_PHOTO_CAPTURE_PORT.requestPermission,
    permissionRetirement: module.permissionRetirement?.bind(module) ?? (module.requestPermission
      ? (operation: CapturePermissionOperation) => ({ operation, status: 'unknown' as const })
      : UNAVAILABLE_PHOTO_CAPTURE_PORT.permissionRetirement),
    preview: module.preview?.bind(module) ?? UNAVAILABLE_PHOTO_CAPTURE_PORT.preview,
    retake: module.retake?.bind(module) ?? UNAVAILABLE_PHOTO_CAPTURE_PORT.retake,
    invalidatePreviews: module.invalidatePreviews?.bind(module) ?? UNAVAILABLE_PHOTO_CAPTURE_PORT.invalidatePreviews,
  });
}
