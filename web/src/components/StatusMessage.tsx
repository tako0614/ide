interface StatusMessageProps {
  message: string;
}

export const StatusMessage = ({ message }: StatusMessageProps) => {
  if (!message) return null;

  return (
    <div className="status-float" role="status">
      {message}
    </div>
  );
};
