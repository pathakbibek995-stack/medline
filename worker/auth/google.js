import {createRemoteJWKSet, customFetch, jwtVerify} from 'jose';
const keys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'),{
 [customFetch]:(...args)=>globalThis.fetch(...args),
});
export async function verifyGoogleIdentity(token,clientID){
 const {payload}=await jwtVerify(token,keys,{
  algorithms:['RS256'],issuer:['https://accounts.google.com','accounts.google.com'],audience:clientID,
  requiredClaims:['exp','sub','email','email_verified'],
 });
 if(typeof payload.sub!=='string'||!payload.sub||typeof payload.email!=='string'||payload.email_verified!==true)throw new Error('Use a verified Google account.');
 if(payload.azp!==undefined&&payload.azp!==clientID)throw new Error('Google account is authorized for another app.');
 if(Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==clientID)throw new Error('Google account authorization is incomplete.');
 return {actor:payload.sub,email:payload.email.trim().toLowerCase(),name:typeof payload.name==='string'?payload.name:payload.email};
}
