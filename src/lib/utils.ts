/**
 * Calculates the Haversine distance between two coordinates in kilometers.
 */
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1); 
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  const distance = R * c; // Distance in km
  return distance;
}

function deg2rad(deg: number): number {
  return deg * (Math.PI/180);
}

export function withTimeout<T = any>(promise: Promise<T>, label: string, timeoutMs = 1500): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

export function getIstDateKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

export function getIstStartOfDay(date: Date = new Date()): Date {
  const istDate = getIstDateKey(date);
  return new Date(`${istDate}T00:00:00.000+05:30`);
}
