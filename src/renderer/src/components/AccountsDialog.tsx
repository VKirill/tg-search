import { useEffect, useState } from 'react';
import type { Account } from '../../../shared/types';
import { avatarColor, initials } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { Modal } from './Modal';
import { useToast } from './Toast';

type AccountsDialogProps = {
  onClose: () => void;
  onChange: () => void;
};

type LoginStep = 'list' | 'phone' | 'code' | 'password';

export function AccountsDialog({ onClose, onChange }: AccountsDialogProps) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [step, setStep] = useState<LoginStep>('list');
  const [phone, setPhone] = useState('');
  const [loginId, setLoginId] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    getApi()
      .accounts.list()
      .then(setAccounts)
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    load();
  }, []);

  const updateLimit = async (id: number, field: 'dailyLimit' | 'pauseSec', value: number) => {
    try {
      await getApi().accounts.update(id, { [field]: value });
      load();
      onChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('Удалить сессию?')) return;
    try {
      await getApi().accounts.remove(id);
      load();
      onChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const startLogin = async () => {
    setError(null);
    try {
      const st = await getApi().accounts.startLogin(phone);
      setLoginId(st.accountId);
      setStep('code');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitCode = async () => {
    if (loginId == null) return;
    setError(null);
    try {
      const st = await getApi().accounts.submitCode(loginId, code);
      if (st.status === 'wait_password') setStep('password');
      else if (st.error) setError(st.error);
      else {
        setStep('list');
        load();
        onChange();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitPassword = async () => {
    if (loginId == null) return;
    setError(null);
    try {
      const st = await getApi().accounts.submitPassword(loginId, password);
      if (st.error) setError(st.error);
      else {
        setStep('list');
        load();
        onChange();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal title="Аккаунты Telegram" onClose={onClose} wide>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 0 }}>
        Сессии и лимиты каждого аккаунта изолированы.
      </p>

      {step === 'list' && (
        <>
          {accounts.map((a) => {
            const name = [a.firstName, a.lastName].filter(Boolean).join(' ') || a.phone;
            return (
              <div key={a.id} className="account-card">
                <div className="account-card__head">
                  {a.photoPath ? (
                    <img src={`file://${a.photoPath}`} alt="" width={40} height={40} style={{ borderRadius: 8 }} />
                  ) : (
                    <div className="avatar" style={{ background: avatarColor(name) }}>{initials(name)}</div>
                  )}
                  <div>
                    <div style={{ fontWeight: 500 }}>{name}</div>
                    {a.username && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>@{a.username}</div>}
                    {a.isPrimary && <span className="badge">Основной аккаунт</span>}
                  </div>
                </div>
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Общий лимит: осталось {a.dailyLimit - a.sentToday} из</label>
                  <input
                    type="number"
                    value={a.dailyLimit}
                    onChange={(e) => updateLimit(a.id, 'dailyLimit', Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>Пауза между отправками, с</label>
                  <input
                    type="number"
                    value={a.pauseSec}
                    onChange={(e) => updateLimit(a.id, 'pauseSec', Number(e.target.value))}
                  />
                </div>
                <button type="button" className="danger-text" onClick={() => remove(a.id)}>Удалить сессию</button>
              </div>
            );
          })}
          <button type="button" className="btn btn--primary" onClick={() => setStep('phone')}>Добавить аккаунт</button>
        </>
      )}

      {step === 'phone' && (
        <>
          <div className="field">
            <label>Телефон</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7…" />
          </div>
          {error && <p className="composer__error">{error}</p>}
          <button type="button" className="btn btn--primary" onClick={startLogin}>Продолжить</button>
          <button type="button" className="btn" onClick={() => setStep('list')}>Назад</button>
        </>
      )}

      {step === 'code' && (
        <>
          <div className="field">
            <label>Код из Telegram</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          {error && <p className="composer__error">{error}</p>}
          <button type="button" className="btn btn--primary" onClick={submitCode}>Подтвердить</button>
        </>
      )}

      {step === 'password' && (
        <>
          <div className="field">
            <label>Пароль 2FA</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p className="composer__error">{error}</p>}
          <button type="button" className="btn btn--primary" onClick={submitPassword}>Войти</button>
        </>
      )}
    </Modal>
  );
}
