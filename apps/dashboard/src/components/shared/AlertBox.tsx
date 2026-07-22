import React from 'react';

interface AlertBoxProps {
  type: 'info' | 'warning' | 'danger';
  title: string;
  message: string;
}

const AlertBox: React.FC<AlertBoxProps> = ({ type, title, message }) => {
  const styles = {
    info: {
      container: 'bg-info-bg border-info-border',
      title: 'text-info',
      message: 'text-info',
    },
    warning: {
      container: 'bg-warning-bg border-warning-border',
      title: 'text-warning',
      message: 'text-warning',
    },
    danger: {
      container: 'bg-danger-bg border-danger-border',
      title: 'text-danger',
      message: 'text-danger',
    },
  };

  const style = styles[type];

  return (
    <div className={`${style.container} border rounded-xl p-4`}>
      <p className={`text-sm ${style.title} font-medium mb-1`}>{title}</p>
      <p className={`text-xs ${style.message}`}>{message}</p>
    </div>
  );
};

export default AlertBox;

