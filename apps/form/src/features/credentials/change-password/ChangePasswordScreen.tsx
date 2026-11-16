import { Component } from 'react';
import { createChangePasswordController, type CredentialTransition } from '../model';
import { t } from '../../shared/tokens';
import { Gutter, Nav, Notice, PlainAction, PrimaryAction, Screen, Stack, Subtitle, TextAnswer, Title } from '../../shared/ui';

export type ChangePasswordScreenProps = {
  controller: ReturnType<typeof createChangePasswordController>;
  onBack: () => void;
  onContinue: (transition: CredentialTransition) => void;
};
const empty = () => ({ passwords: ['', '', ''], shown: [false, false, false] });
const initial = (controller: ChangePasswordScreenProps['controller']) => ({
  controller, lifetime: {}, continued: false, revision: 0,
});
type State = ReturnType<typeof initial>;

export class ChangePasswordScreen extends Component<ChangePasswordScreenProps, State> {
  state = initial(this.props.controller);
  private mountedLifetime: object | null = null;
  private fields = { lifetime: this.state.lifetime, ...empty() };
  private continuedLifetime: object | null = null;
  private unsubscribe: (() => void) | undefined;

  static getDerivedStateFromProps(props: ChangePasswordScreenProps, state: State) {
    return props.controller === state.controller ? null : initial(props.controller);
  }
  componentDidMount() { this.mountedLifetime = {}; this.listen(); }
  componentDidUpdate(previous: ChangePasswordScreenProps) {
    if (previous.controller !== this.props.controller) { this.unsubscribe?.(); this.listen(); }
  }
  componentWillUnmount() {
    this.mountedLifetime = null; this.unsubscribe?.();
    this.fields = { lifetime: this.state.lifetime, ...empty() };
  }
  private listen() {
    const { controller, lifetime } = this.state;
    const mountedLifetime = this.mountedLifetime;
    this.unsubscribe = controller.subscribe(() => {
      if (this.current(lifetime, mountedLifetime)) this.refresh();
    });
    this.refresh();
  }
  private refresh() { this.setState(state => ({ revision: state.revision + 1 })); }
  private current(lifetime: object, mountedLifetime: object | null) {
    return mountedLifetime !== null && this.mountedLifetime === mountedLifetime
      && this.state.lifetime === lifetime && this.state.controller === this.props.controller;
  }
  private editable(lifetime: object, mountedLifetime: object | null) {
    return this.current(lifetime, mountedLifetime) && ['idle', 'failed'].includes(this.props.controller.snapshot().status);
  }
  private submit(lifetime: object, mountedLifetime: object | null) {
    if (!this.editable(lifetime, mountedLifetime)) return;
    const [current, password, confirmation] = this.fields.passwords;
    if (current.length < 1 || current.length > 128) return;
    this.fields = { lifetime, ...empty() }; this.refresh();
    void this.props.controller.submit(current, password, confirmation);
  }
  render() {
    const presentation = this.props;
    const { controller, onBack, onContinue } = presentation;
    const { lifetime } = this.state;
    if (this.fields.lifetime !== lifetime) this.fields = { lifetime, ...empty() };
    const { passwords, shown } = this.fields;
    const mountedLifetime = this.mountedLifetime;
    const isCurrent = () => this.props === presentation && this.current(lifetime, mountedLifetime);
    const submit = () => { if (isCurrent()) this.submit(lifetime, mountedLifetime); };
    const snapshot = controller.snapshot();
    const blocked = !['idle', 'failed'].includes(snapshot.status);
    const labels = ['Current password', 'New password', 'Confirm new password'];
    return (
      <Screen testID="screen-change-password" nav={<Nav back="Settings" onBack={() => {
        if (isCurrent()) onBack();
      }} />}>
        <Gutter>
          <Title text="Change password" />
          <Subtitle text="Use a new password between 12 and 128 characters." />
        </Gutter>
        <Gutter style={{ marginTop: t.space.s32, gap: t.space.s20 }}>
          {snapshot.notice ? <Notice kind={snapshot.status === 'failed' ? 'error' : 'info'} text={snapshot.notice} announce /> : null}
          {snapshot.status === 'pending' ? <Notice kind="info" text="Changing your password…" /> : null}
          <Stack gap="s20">
            {labels.map((label, index) => <TextAnswer key={label} label={label} value={passwords[index]}
              secure={!shown[index]} autoComplete={index === 0 ? 'current-password' : 'new-password'}
              textContentType={index === 0 ? 'password' : 'newPassword'} autoCapitalize="none" maxLength={128}
              onChangeText={value => {
                if (isCurrent() && this.editable(lifetime, mountedLifetime)) {
                  this.fields.passwords = this.fields.passwords.map((old, i) => i === index ? value : old); this.refresh();
                }
              }} onSubmitEditing={submit}
              trailing={<PlainAction label={shown[index] ? 'Hide' : 'Show'} chevron={null} disabled={blocked}
                accessibilityLabel={`${shown[index] ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
                onPress={() => {
                  if (isCurrent() && this.editable(lifetime, mountedLifetime)) {
                    this.fields.shown = this.fields.shown.map((old, i) => i === index ? !old : old); this.refresh();
                  }
                }} />} />)}
          </Stack>
        </Gutter>
        <Gutter style={{ marginTop: t.space.s32, gap: t.space.s8 }}>
          <PrimaryAction label="Change password" disabled={blocked || passwords[0].length < 1}
            loading={snapshot.status === 'pending'} onPress={submit} />
          <PlainAction label="Continue" chevron={null} disabled={!controller.transition() || this.state.continued}
            onPress={() => {
              if (!isCurrent() || this.continuedLifetime === lifetime) return;
              const transition = controller.transition();
              if (!transition || !isCurrent()) return;
              this.continuedLifetime = lifetime;
              this.setState({ continued: true });
              onContinue(transition);
            }} />
        </Gutter>
      </Screen>
    );
  }
}
