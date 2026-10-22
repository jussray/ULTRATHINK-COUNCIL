import {createServer} from 'node:http';
import {createLocalCouncilBus, BusFault} from './localBus.mjs';

export function createLocalCouncilBusServer(bus) {
  return createServer(async(req,res)=>{
    const finish=(status,body)=>{
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff'});
      res.end(JSON.stringify(body));
    };
    if(req.method==='GET' && req.url==='/health')return finish(200,{status:'ok',mode:'local-reference'});
    const route={'/v1/publish':'publish','/v1/claim':'claim','/v1/ack':'acknowledge'}[req.url];
    if(req.method!=='POST'||!route)return finish(404,{error:'NOT_FOUND'});
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return finish(415,{error:'JSON_REQUIRED'});
    let bytes=0;const parts=[];
    try{
      for await(const chunk of req){
        bytes+=chunk.length;
        if(bytes>65536)return finish(413,{error:'BODY_TOO_LARGE'});
        parts.push(chunk);
      }
      const message=JSON.parse(Buffer.concat(parts).toString('utf8'));
      const output=bus[route](message);
      return finish(200,output);
    }catch(e){
      const code=e instanceof BusFault?e.code:'INVALID_OR_UNAVAILABLE';
      const status=code==='UNAUTHENTICATED'||code==='ORIGIN_NOT_AUTHORIZED'?401:
        code==='REPLAYED_CLAIM'||code==='CONFLICTING_HANDOFF'||code==='ACK_CONFLICT'?409:
        code==='QUEUE_CAPACITY'?429:400;
      return finish(status,{error:code});
    }
  });
}
export function startLocalCouncilBusFromEnvironment(env=process.env) {
  const keys=['COUNCIL_BUS_DB_PATH','COUNCIL_BUS_INGRESS_PUBLIC_KEY_PEM',
    'COUNCIL_BUS_ORIGIN_PUBLIC_KEY_PEM','COUNCIL_BUS_PRIVATE_KEY_PEM',
    'COUNCIL_BUS_ORIGIN_AGENT','COUNCIL_BUS_ORIGIN_ROUTE'];
  if(keys.some(key=>!env[key]))throw Error('Missing required Council Bus local configuration');
  const bus=createLocalCouncilBus({
    dbPath:env.COUNCIL_BUS_DB_PATH,
    ingressPublicKey:env.COUNCIL_BUS_INGRESS_PUBLIC_KEY_PEM,
    originPublicKey:env.COUNCIL_BUS_ORIGIN_PUBLIC_KEY_PEM,
    busPrivateKey:env.COUNCIL_BUS_PRIVATE_KEY_PEM,
    allowedOriginAgent:env.COUNCIL_BUS_ORIGIN_AGENT,
    allowedOriginRoute:env.COUNCIL_BUS_ORIGIN_ROUTE,
  });
  const port=Number(env.COUNCIL_BUS_PORT||8789);
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('Invalid local port');
  const server=createLocalCouncilBusServer(bus);
  server.listen(port,'127.0.0.1');
  server.on('close',()=>bus.close());
  return server;
}
