import { angle } from './math.js';

// Curvature belongs to the driven curve, not its centreline parameter.
export function pathCurvature(a,b,c){
  const ab=Math.hypot(b.x-a.x,b.z-a.z),bc=Math.hypot(c.x-b.x,c.z-b.z);
  if(ab<1e-5||bc<1e-5)return 0;
  return angle(Math.atan2(c.x-b.x,c.z-b.z)-Math.atan2(b.x-a.x,b.z-a.z))/((ab+bc)*.5);
}
