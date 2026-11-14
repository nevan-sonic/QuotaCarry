export type TeamRole='owner'|'administrator'|'developer'|'viewer';

export function canManageTeam(role:TeamRole|null,target:TeamRole){
  return target!=='owner'&&(role==='owner'||(role==='administrator'&&['developer','viewer'].includes(target)));
}

export function canManageAdapter(role:TeamRole|null){
  return role==='owner'||role==='administrator';
}
