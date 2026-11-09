// Local-only demonstration. A real Council Bus deployment and its backing
// are separate founder-authorized decisions. Never expose this listener publicly.
import {startLocalCouncilBusFromEnvironment} from './http.mjs';
const server=startLocalCouncilBusFromEnvironment();
server.on('listening',()=>{
  process.stdout.write('Council Bus local reference listening on loopback only; not a live agent connector.\n');
});
