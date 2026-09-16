/**
 * Events MqttService emits via EventEmitter2. Kept in their own file so
 * consumers (DevicesService today; Alerts/Automation later) can import the
 * shape without importing MqttService itself.
 */
export interface DeviceStatusEvent {
  deviceId: string;
  baseTopic: string;
  online: boolean;
}

export const DEVICE_STATUS_EVENT = "device.status";
