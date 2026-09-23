import {
  Building,
  DraftingCompass,
  Handshake,
  HardHat,
  Landmark,
  Layers,
  MapPin,
  SearchCheck,
  Video,
  type LucideIcon,
} from 'lucide-react';

const icons: Record<string, LucideIcon> = {
  'hard-hat': HardHat,
  'search-check': SearchCheck,
  'drafting-compass': DraftingCompass,
  building: Building,
  video: Video,
  handshake: Handshake,
  'map-pin': MapPin,
  landmark: Landmark,
};

export function ServiceIcon({ iconKey, className }: { iconKey: string | null; className?: string }) {
  const Icon = (iconKey && icons[iconKey]) || Layers;
  return <Icon aria-hidden="true" className={className ?? 'h-5 w-5'} />;
}
