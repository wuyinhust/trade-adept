import os,sys,json,secrets,hashlib,traceback
from datetime import timedelta
from unittest.mock import patch
os.chdir('/home/frappe/frappe-bench/sites')
sys.path.insert(0,'/tmp/tradept-login-review')
import frappe
frappe.init(site='tradept-login-review-20261013.test');frappe.connect();frappe.set_user('Administrator')
from tradept_core import enterprise_login as login, administrator, repository as repo, branding
from tradept_core.install import _doctype, _field
from tradept_core.domain import DEFAULT_ROLES
from tradept_core.schema import dumps
from frappe.utils import now_datetime
from frappe.utils.password import check_password
checks=[]
synthetic_sids=[]
def session_exists(sid):
 return bool(frappe.db.sql('SELECT sid FROM `tabSessions` WHERE sid=%s LIMIT 1',(sid,)))
def rerun_install_access_settings():
 # Exercise the actual after_migrate installation entrypoint. Schema/assets and
 # branding are separate concerns; suppress their writes on the minimal site.
 from tradept_core import install,assets
 with patch.object(install,'_doctype'),patch.object(install,'create_custom_fields'),patch.object(assets,'ensure'),patch.object(branding,'install'):
  install.install()
def session_for(user):
 sid='tradept-login-proof-'+secrets.token_hex(24)
 synthetic_sids.append(sid)
 frappe.db.sql('INSERT INTO `tabSessions` (sid, user, sessiondata, lastupdate, status) VALUES (%s,%s,%s,%s,%s)',(sid,user,'{}',now_datetime(),'Active'))
 frappe.cache.hset('session',sid,{'user':user,'sid':sid,'data':{}})
 return sid
def ok(name, condition):
 if not condition:raise AssertionError(name)
 checks.append(name)
def denied(name, fn):
 try: fn()
 except (frappe.ValidationError,frappe.AuthenticationError):checks.append(name)
 else:raise AssertionError(name)
def member_transaction_checks():
 import copy
 from frappe.auth import LoginManager
 from frappe.model.document import Document
 # Use the real logout/run_trigger methods. Construct the request's manager
 # without logging in or creating another session as a constructor side effect.
 manager=LoginManager.__new__(LoginManager)
 manager.user='Administrator';manager.info=None;manager.full_name=None
 manager.user_type='System User';manager.user_lang='en';manager.resume=True
 frappe.set_user('Administrator')
 cfg=login.configuration() if hasattr(login,'configuration') else json.loads(frappe.db.get_value('Trade Workspace','workspace','configuration'))
 cfg=copy.deepcopy(cfg);cfg.pop('loginPolicy',None);cfg.pop('loginSetup',None)
 uid='member-proof-'+secrets.token_hex(6);email=uid+'@example.invalid'
 password=secrets.token_urlsafe(28);replacement=secrets.token_urlsafe(28)
 saved_manager=getattr(frappe.local,'login_manager',None)
 original_save=Document.save
 member={'id':uid,'email':email,'username':uid,'name':'Member Transaction Proof','role':'admin','temporaryPassword':password,'visibleCompanyIds':[]}
 def snapshot():
  return (frappe.db.get_value('User',email,['enabled','user_type','modified'],as_dict=True),
   frappe.db.sql('SELECT role FROM `tabHas Role` WHERE parent=%s ORDER BY role',(email,)),
   frappe.db.sql('SELECT fieldname,password,encrypted FROM `__Auth` WHERE doctype=%s AND name=%s ORDER BY fieldname',('User',email)),
   frappe.db.get_value('Trade User Profile',{'user':email},['profile','role_key','team_id','modified'],as_dict=True),
   frappe.db.get_value('Trade Workspace','workspace','configuration'))
 try:
  frappe.local.login_manager=None
  administrator._member(cfg,{'id':'native-admin'},member)
  user=frappe.get_doc('User',email);user.append('roles',{'role':'System Manager'});user.logout_all_sessions=1;user.save(ignore_permissions=True)
  sid=session_for(email)
  frappe.db.commit()
  baseline=snapshot()
  ok('member_fixture_has_real_system_user_profile_sid',baseline[0].user_type=='System User' and session_exists(sid))
  frappe.local.login_manager=manager
  for label,changes in [('disable',{'disabled':True}),('role',{'role':'salesperson'}),('password',{'temporaryPassword':replacement})]:
   frappe.db.savepoint('member_failure')
   native_reached=[]
   def fail_after_profile(doc,*args,**kwargs):
    result=original_save(doc,*args,**kwargs)
    if doc.doctype=='Trade User Profile' and doc.user==email:
     if label=='disable':assert not frappe.db.get_value('User',email,'enabled')
     elif label=='role':assert frappe.db.get_value('User',email,'user_type')=='Website User'
     else:assert check_password(email,replacement)==email
     native_reached.append(True)
     raise RuntimeError('injected post-profile-save failure')
    return result
   with patch.object(Document,'save',fail_after_profile),patch.object(frappe.db,'commit',side_effect=AssertionError('implicit_commit_in_member_'+label)),patch.object(LoginManager,'logout',autospec=True,side_effect=LoginManager.logout) as logout:
    try:administrator._member(copy.deepcopy(cfg),{'id':'native-admin'},{**member,'temporaryPassword':None,**changes})
    except RuntimeError as error:assert str(error)=='injected post-profile-save failure'
    else:raise AssertionError('member_failure_expected_'+label)
    if label=='disable':ok('disabled_member_executes_real_login_manager_logout',logout.call_count==1)
   ok('member_'+label+'_reaches_profile_failure_without_commit',bool(native_reached))
   frappe.db.rollback(save_point='member_failure')
   ok('member_'+label+'_rollback_preserves_user_auth_profile_configuration',snapshot()==baseline)
   ok('member_'+label+'_rollback_preserves_sql_session_and_redis',session_exists(sid) and bool(frappe.cache.hget('session',sid)))
  # Flushing the callbacks from failed savepoints must not log the member out.
  frappe.db.commit()
  ok('member_failed_updates_later_commit_keeps_session',session_exists(sid) and bool(frappe.cache.hget('session',sid)))
  with patch.object(frappe.db,'commit',side_effect=AssertionError('implicit_commit_in_member_success')):
   administrator._member(copy.deepcopy(cfg),{'id':'native-admin'},{**member,'role':'salesperson','disabled':True,'temporaryPassword':replacement})
  ok('member_success_defers_redis_eviction_until_commit',not session_exists(sid) and bool(frappe.cache.hget('session',sid)))
  frappe.db.commit()
  ok('member_success_commit_revokes_sql_session_and_redis',not session_exists(sid) and not frappe.cache.hget('session',sid))
  ok('member_success_commits_user_password_and_profile',not frappe.db.get_value('User',email,'enabled') and check_password(email,replacement)==email and frappe.db.get_value('Trade User Profile',{'user':email},'role_key')=='salesperson')
 finally:
  frappe.local.login_manager=saved_manager
  frappe.db.rollback()
  frappe.db.delete('Trade User Profile',{'user':email})
  if frappe.db.exists('User',email):frappe.delete_doc('User',email,force=True,ignore_permissions=True)
  frappe.db.commit()
try:
 if not frappe.db.exists('Module Def','Tradept Core'):
  frappe.get_doc({'doctype':'Module Def','module_name':'Tradept Core','app_name':'tradept_core','custom':1}).insert(ignore_permissions=True)
 _doctype('Trade Workspace',[_field('configuration','Long Text'),_field('revision','Int')])
 _doctype('Trade User Profile',[_field('user','Link',options='User',unique=1),_field('record_id',unique=1),_field('profile','Long Text'),_field('role_key'),_field('team_id')])
 login.install()
 for key in DEFAULT_ROLES:
  name='Tradept '+key.title()
  if not frappe.db.exists('Role',name):frappe.get_doc({'doctype':'Role','role_name':name,'desk_access':0}).insert(ignore_permissions=True)
 cfg={'id':'auth-review','companies':[],'teams':{},'roles':DEFAULT_ROLES,'loginPolicy':{'enabled':True,'mode':'domains','domains':['example.invalid'],'addresses':[],'publicOrigin':'https://trade.example.invalid'}}
 if not frappe.db.exists('Trade Workspace','workspace'):
  work=frappe.new_doc('Trade Workspace');work.name='workspace';work.configuration=dumps(cfg);work.revision=0;work.insert(ignore_permissions=True,set_name='workspace')
 else:frappe.db.set_value('Trade Workspace','workspace','configuration',dumps(cfg))
 frappe.db.commit()
 email='review-'+secrets.token_hex(4)+'@example.invalid'
 real_exists=frappe.db.exists
 def exists(dt,*args,**kwargs):
  if dt=='Email Account':return True
  return real_exists(dt,*args,**kwargs)
 with patch.object(frappe.db,'exists',side_effect=exists),patch.object(frappe,'sendmail') as mail:
  member=administrator._member(cfg,{'id':'bootstrap'},{'id':'review-'+secrets.token_hex(4),'name':'Login Review','email':email,'role':'admin','visibleCompanyIds':[],'sendInvitation':True})
  ok('invitation_queued_without_exposing_key',member['emailDelivery']=='queued' and 'key' not in member)
  message=mail.call_args.kwargs['message']
  import re
  key=re.search(r'#set-password=([^"<]+)',message).group(1)
  ok('native_hash_only',frappe.db.get_value('User',email,'reset_password_key')==hashlib.sha256(key.encode()).hexdigest())
  ok('mail_uses_configured_brand_origin','https://trade.example.invalid/#set-password=' in message)
 denied('unverified_member_cannot_login',lambda:login.require_access(email))
 password=secrets.token_urlsafe(28)
 activation_sid=session_for(email)
 frappe.set_user('Guest')
 with patch.object(repo,'finish',return_value={}) as audit,patch.object(frappe.db,'commit',side_effect=AssertionError('implicit_commit_in_password_activation')):
  result=login.complete_password(key,password)
  ok('activation_updates_native_password',result['ok'] and check_password(email,password)==email)
  ok('activation_requires_fresh_login',frappe.session.user=='Guest')
  ok('activation_audited',audit.call_count==1)
 ok('activation_revokes_real_session_without_commit',not session_exists(activation_sid) and bool(frappe.cache.hget('session',activation_sid)))
 login.require_access(email);checks.append('verified_member_can_login')
 ok('native_key_consumed',not frappe.db.get_value('User',email,'reset_password_key'))
 denied('activation_link_cannot_replay',lambda:login.complete_password(key,secrets.token_urlsafe(28)))
 expired_key=secrets.token_urlsafe(24)
 frappe.db.set_value('User',email,{'reset_password_key':hashlib.sha256(expired_key.encode()).hexdigest(),'last_reset_password_key_generated_on':now_datetime()-timedelta(hours=2)})
 denied('expired_link_cannot_change_password',lambda:login.complete_password(expired_key,secrets.token_urlsafe(28)))
 ok('expired_attempt_keeps_password',check_password(email,password)==email)
 frappe.db.set_value('User',email,login.CHANGE,1)
 denied('forced_change_blocks_old_session',lambda:login.require_access(email))
 frappe.db.set_value('User',email,login.CHANGE,0)
 cfg['loginPolicy']['domains']=['other.invalid'];frappe.db.set_value('Trade Workspace','workspace','configuration',dumps(cfg))
 denied('allowlist_change_blocks_old_session',lambda:login.require_access(email))
 cfg['loginPolicy']['mode']='all';frappe.db.set_value('Trade Workspace','workspace','configuration',dumps(cfg))
 denied('all_mode_still_requires_invitation',lambda:login.require_access('outsider@other.invalid'))
 with patch.object(frappe,'sendmail') as mail:
  a=login.forgot_password('not-invited@other.invalid');b=login.forgot_password('invalid')
  ok('forgot_response_does_not_enumerate_members',a==b and mail.call_count==0)
 boot=frappe._dict(app_data=[{'app_name':'erpnext','app_title':'ERPNext'},{'app_name':'frappe','app_title':'Frappe'}]);branding.boot_session(boot)
 ok('desk_v16_display_branding',boot.app_data[0]['app_title']=='Tradept' and boot.app_data[0]['app_name']=='erpnext')
 # Native operators keep their own permission boundary; Tradept identities do not.
 from tradept_core import request_guard
 from types import SimpleNamespace
 frappe.set_user('Administrator')
 operator='operator-'+secrets.token_hex(4)+'@native.invalid'
 frappe.get_doc({'doctype':'User','email':operator,'first_name':'Operator Review','enabled':1,'send_welcome_email':0,'user_type':'System User','roles':[{'role':'System Manager'}]}).insert(ignore_permissions=True)
 login.require_access(operator);checks.append('native_system_operator_outside_allowlist_remains_available')
 frappe.local.form_dict=frappe._dict(usr=operator)
 login.before_login();checks.append('native_operator_before_login_uses_native_auth')
 frappe.set_user(operator)
 frappe.local.request=SimpleNamespace(path='/api/method/frappe.client.get_list',headers={},method='GET')
 frappe.local.form_dict=frappe._dict()
 request_guard.check_request();checks.append('native_operator_retains_standard_rpc_guard')
 frappe.set_user(email)
 frappe.local.request=SimpleNamespace(path='/api/resource/Sales%20Invoice',headers={},method='GET')
 try:request_guard.check_request()
 except frappe.PermissionError:checks.append('verified_tradept_member_still_denied_native_rest')
 else:raise AssertionError('verified_tradept_member_still_denied_native_rest')
 frappe.set_user('Administrator')
 operator_doc=frappe.get_doc('User',operator)
 operator_doc.append('roles',{'role':'Tradept Admin'});operator_doc.save(ignore_permissions=True);frappe.clear_cache(user=operator)
 denied('unprovisioned_tradept_role_cannot_use_operator_exception',lambda:login.require_access(operator))
 website='website-'+secrets.token_hex(4)+'@native.invalid'
 frappe.get_doc({'doctype':'User','email':website,'first_name':'Website Review','enabled':1,'send_welcome_email':0,'user_type':'Website User'}).insert(ignore_permissions=True)
 denied('uninvited_website_user_does_not_get_operator_exception',lambda:login.require_access(website))
 frappe.local.request=None
 # Bootstrap starts with no domain, mailbox list or SMTP credentials.
 from tradept_core import login_setup
 from tradept_core.domain import APIError
 from frappe.core.doctype.user.user import User
 from pathlib import Path
 cfg.pop('loginPolicy',None)
 cfg['allowNativeSignup']=True
 frappe.db.set_value('Trade Workspace','workspace','configuration',dumps(cfg))
 frappe.set_user('Administrator')
 username='setup-'+secrets.token_hex(4)
 initial_password=secrets.token_urlsafe(28)
 private=Path('/tmp/tradept-auth-bootstrap-'+secrets.token_hex(4)+'.json')
 private.write_text(json.dumps({'administrator':{'id':'bootstrap-review','username':username,'password':initial_password}}));private.chmod(0o600)
 try:
  with patch.object(repo,'finish',return_value={}):
   result=login_setup.provision(str(private))
 finally:private.unlink()
 cfg=login_setup.configuration();bootstrap=cfg['loginSetup']['bootstrapUser']
 ok('bootstrap_requires_no_domain_email_or_smtp',result['setupRequired'] and cfg['loginPolicy']=={'enabled':False})
 ok('bootstrap_persists_native_signup_disabled',cfg.get('allowNativeSignup') is False)
 rerun_install_access_settings()
 ok('bootstrap_migration_keeps_signup_disabled',frappe.db.get_single_value('Website Settings','disable_signup')==1)
 credentials=User.find_by_credentials(username,initial_password)
 ok('initial_username_authenticates_native_password',credentials.name==bootstrap and credentials.is_authenticated)
 ok('public_login_mode_has_no_admin_identity',login.login_config()=={'emailOnly':False,'setupRequired':True,'invitationOnly':True,'brand':'Tradept'})
 login.require_access(bootstrap);checks.append('bootstrap_access_remains_before_verification')
 denied('legacy_account_blocked_during_setup',lambda:login.require_access(email))
 actor={'id':'bootstrap-review','nativeUser':bootstrap}
 for action, payload in [('changes',{}),('finance_operation',{}),('admin_update',{'resource':'member'}),('snapshots',{}),('catalog_state',{}),('catalog_operation',{})]:
  try:login_setup.guard(cfg,actor,action,payload)
  except APIError:pass
  else:raise AssertionError('setup_scope_'+action)
 checks.append('bootstrap_cannot_operate_business_or_add_members')
 login_setup.guard(cfg,actor,'admin_update',{'resource':'catalog_template'})
 checks.append('bootstrap_allows_catalog_permission_configuration_only')
 candidate={'mode':'domains','domains':['example.invalid'],'addresses':[],'publicOrigin':'https://trade.example.invalid','administratorEmail':'owner-'+secrets.token_hex(4)+'@example.invalid'}
 target=candidate['administratorEmail']
 with patch.object(frappe,'sendmail') as mail:
  result=login.configure(cfg,actor,candidate)
  ok('save_draft_without_smtp_or_mail',not mail.called and result['activationRequired'] and not cfg['loginPolicy']['enabled'])
 frappe.db.set_value('Trade Workspace','workspace','configuration',dumps(cfg))
 with patch.object(frappe.db,'exists',side_effect=exists),patch.object(frappe,'sendmail') as mail:
  login.configure(cfg,actor,{**candidate,'sendVerification':True})
  old_key=re.search(r'#set-password=([^"<]+)',mail.call_args.kwargs['message']).group(1)
  ok('pending_email_user_is_disabled',not frappe.db.get_value('User',target,'enabled'))
  login.configure(cfg,actor,{**candidate,'publicOrigin':'https://new.example.invalid'})
  frappe.db.set_value('Trade Workspace','workspace','configuration',dumps(cfg))
  denied('editing_setup_invalidates_old_proof',lambda:login.complete_password(old_key,secrets.token_urlsafe(28)))
  login.configure(cfg,actor,{**candidate,'sendVerification':True})
  key=re.search(r'#set-password=([^"<]+)',mail.call_args.kwargs['message']).group(1)
 frappe.db.set_value('Trade Workspace','workspace','configuration',dumps(cfg))
 login.require_access(bootstrap);checks.append('sending_verification_does_not_disable_initial_account')
 denied('initial_password_must_change_on_activation',lambda:login.complete_password(key,initial_password))
 new_password=secrets.token_urlsafe(28)
 bootstrap_sid=session_for(bootstrap)
 frappe.set_user('Guest')
 with patch.object(repo,'finish',return_value={}) as audit,patch.object(frappe.db,'commit',side_effect=AssertionError('implicit_commit_in_setup_activation')):
  result=login.complete_password(key,new_password)
  ok('setup_activation_audited',audit.call_count==1)
 ok('setup_activation_revokes_real_bootstrap_session_without_commit',not session_exists(bootstrap_sid))
 cfg=login_setup.configuration()
 ok('verification_atomically_enables_email_policy',cfg['loginPolicy']['enabled'] and 'loginSetup' not in cfg)
 ok('bootstrap_account_disabled_after_activation',not frappe.db.get_value('User',bootstrap,'enabled'))
 ok('admin_identity_retained_when_binding_email',frappe.db.get_value('Trade User Profile',{'user':target},'record_id')=='bootstrap-review')
 ok('verified_admin_can_authenticate',check_password(target,new_password)==target)
 login.require_access(target);checks.append('verified_admin_passes_policy')
 denied('old_bootstrap_session_rejected',lambda:login.require_access(bootstrap))
 denied('setup_activation_is_single_use',lambda:login.complete_password(key,secrets.token_urlsafe(28)))
 ok('public_login_switches_to_email',login.login_config()['emailOnly'])
 rerun_install_access_settings()
 ok('activated_migration_keeps_signup_disabled_and_email_only',frappe.db.get_single_value('Website Settings','disable_signup')==1 and frappe.db.get_single_value('System Settings','allow_login_using_user_name')==0)
 # Deployment generation retires demo credentials without deleting ownership.
 import copy,tempfile
 cfg.pop('loginPolicy',None);cfg.pop('loginSetup',None)
 catalog_caps={'catalog.read','catalog.create','catalog.write','catalog.disable'}
 cfg['roles']['admin']['permissions']=[cap for cap in cfg['roles']['admin']['permissions'] if cap not in catalog_caps]
 cfg['roles']['legacy_catalog_observer']={'scope':'tenant','permissions':['read'],'pages':[]}
 frappe.db.set_value('Trade Workspace','workspace','configuration',dumps(cfg))
 frappe.set_user('Administrator')
 legacy_profiles=frappe.get_all('Trade User Profile',fields=['name','user','profile','record_id'])
 cfg_before=copy.deepcopy(cfg)
 api_key=secrets.token_hex(12)
 frappe.db.set_value('User',target,'api_key',api_key)
 bearer=secrets.token_hex(24)
 frappe.get_doc({'doctype':'OAuth Bearer Token','user':target,'access_token':bearer,'refresh_token':secrets.token_hex(24),'expires_in':3600,'status':'Active'}).insert(ignore_permissions=True)
 private_dir=Path(tempfile.mkdtemp(prefix='tradept-deployment-proof-'));private_dir.chmod(0o700)
 output=private_dir/'initial-admin.json'
 deployment_sid=session_for(target)
 try:
  with patch.object(repo,'finish',side_effect=RuntimeError('injected audit failure')),patch.object(frappe.db,'commit',side_effect=AssertionError('implicit_commit_in_failed_deployment')):
   try:login_setup.provision_deployment(str(output))
   except RuntimeError:pass
   else:raise AssertionError('deployment_failure_expected')
  ok('failed_deployment_removes_uncommitted_credentials',not output.exists())
  ok('failed_deployment_restores_configuration',login_setup.configuration()==cfg_before)
  ok('failed_deployment_restores_user_and_password',frappe.db.get_value('User',target,'enabled') and check_password(target,new_password)==target)
  ok('failed_deployment_restores_real_session',bool(session_exists(deployment_sid)))
  with patch.object(repo,'finish',return_value={}) as audit,patch.object(frappe,'sendmail') as deployment_mail,patch.object(frappe.db,'commit',side_effect=AssertionError('implicit_commit_in_deployment')):
   provisioned=login_setup.provision_deployment(str(output))
  ok('deployment_sends_no_mail',not deployment_mail.called)
  access=json.loads(output.read_text())
  cfg=login_setup.configuration();new_bootstrap=cfg['loginSetup']['bootstrapUser']
  ok('deployment_credential_file_private',output.stat().st_mode&0o777==0o600)
  ok('deployment_does_not_return_credentials','username' not in provisioned and 'password' not in provisioned)
  ok('generated_initial_account_authenticates',User.find_by_credentials(access['username'],access['password']).is_authenticated)
  ok('deployment_requires_no_mail_configuration',not cfg['loginPolicy']['enabled'] and login.login_config()['setupRequired'])
  ok('deployment_generates_high_entropy_password',len(access['password'])>=40)
  ok('deployment_keeps_workspace_company_team_identity',all(cfg.get(key)==cfg_before.get(key) for key in ('id','companies','teams')))
  ok('deployment_keeps_nonadmin_roles',all(cfg['roles'][key]==value for key,value in cfg_before['roles'].items() if key!='admin'))
  ok('deployment_admin_has_fine_finance_grants','finance.sales_invoice.submit' in cfg['roles']['admin']['permissions'] and cfg['financePermissions']['roleKeys']==['admin'])
  ok('deployment_explicitly_grants_catalog_to_existing_admin_role',catalog_caps.issubset(set(cfg['roles']['admin']['permissions'])) and cfg['catalogPermissions']['roleKeys']==['admin'])
  ok('deployment_does_not_expand_finance_or_custom_catalog_permissions',all(cfg['roles'][role]==cfg_before['roles'][role] for role in ('finance','legacy_catalog_observer')))
  ok('deployment_audits_once',audit.call_count==1)
  for row in legacy_profiles:
   actual=frappe.db.get_value('Trade User Profile',row.name,['user','profile','record_id'],as_dict=True)
   if actual.user!=row.user or actual.profile!=row.profile or actual.record_id!=row.record_id:raise AssertionError('historical_profiles_preserved')
  checks.append('historical_profiles_preserved_when_retiring_demo')
  ok('old_demo_disabled_and_api_key_removed',not frappe.db.get_value('User',target,'enabled') and not frappe.db.get_value('User',target,'api_key'))
  denied('old_demo_password_revoked',lambda:check_password(target,new_password))
  ok('old_oauth_and_refresh_revoked',frappe.db.get_value('OAuth Bearer Token',bearer,'status')=='Revoked' and not frappe.db.get_value('OAuth Bearer Token',bearer,'refresh_token'))
  ok('deployment_revokes_real_session_without_commit',not session_exists(deployment_sid))
  login.require_access(new_bootstrap);checks.append('generated_bootstrap_access_is_usable')
  denied('old_demo_identity_rejected_after_deployment',lambda:login.require_access(target))
  try:login_setup.provision_deployment(str(output))
  except ValueError:checks.append('deployment_repeat_cannot_rotate_or_overwrite_credentials')
  else:raise AssertionError('deployment_repeat_cannot_rotate_or_overwrite_credentials')
  ok('repeat_keeps_original_credentials',json.loads(output.read_text())==access)
  cfg.pop('loginSetup',None);cfg['allowNativeSignup']=True
  frappe.db.set_value('Trade Workspace','workspace','configuration',dumps(cfg))
  with patch.object(repo,'finish',return_value={}):login_setup.retire_workspace_access()
  ok('retired_site_persists_native_signup_disabled',login_setup.configuration().get('allowNativeSignup') is False)
  rerun_install_access_settings()
  ok('retired_site_migration_keeps_signup_disabled',frappe.db.get_single_value('Website Settings','disable_signup')==1)
 finally:
  output.unlink(missing_ok=True);private_dir.rmdir()
 # Roll back all synthetic accounts first. Only isolated Guest session rows below
 # are committed, to exercise actual database transaction callbacks and Redis.
 frappe.db.rollback()
 member_transaction_checks()
 from tradept_core.session_security import revoke_user_sessions
 sid=session_for('Guest');frappe.db.commit()
 frappe.db.savepoint('session_proof')
 revoke_user_sessions('Guest')
 frappe.db.rollback(save_point='session_proof');frappe.db.commit()
 ok('savepoint_rollback_keeps_session_cache_on_later_commit',session_exists(sid) and bool(frappe.cache.hget('session',sid)))
 revoke_user_sessions('Guest');frappe.db.rollback()
 ok('full_rollback_keeps_session_row_and_cache',session_exists(sid) and bool(frappe.cache.hget('session',sid)))
 revoke_user_sessions('Guest');frappe.db.commit()
 ok('successful_commit_revokes_session_row_and_redis',not session_exists(sid) and not frappe.cache.hget('session',sid))
 print(json.dumps({'ok':True,'checks':checks,'count':len(checks),'mailTransport':'mocked-no-external-mail','database':'isolated-auth-test-site','businessSnapshot':'mocked-no-business-records'},ensure_ascii=False))
except Exception as error:
 print(json.dumps({'ok':False,'type':type(error).__name__,'checks':checks,'message':str(error)[:500]},ensure_ascii=False))
 traceback.print_exc(limit=5)
 sys.exit(1)
finally:
 for sid in synthetic_sids:frappe.cache.hdel('session',sid)
 frappe.db.rollback();frappe.destroy()
