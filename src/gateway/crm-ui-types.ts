export interface LeadContactView {
  name?: string;
  email?: string;
  phone?: string;
  language?: string;
}

export interface LeadAgentView {
  id?: string;
  name: string;
}

export interface LeadPropertyView {
  id?: string;
  reference?: string;
  address?: string;
  price?: string;
  updatedAt?: string;
}

export interface LeadEventView {
  id?: string;
  type?: string;
  title: string;
  location?: string;
  startsAt?: string;
  endsAt?: string;
}

export interface LeadView {
  id: string;
  title: string;
  status?: string;
  origin?: string;
  outcome?: string;
  priority?: string;
  createdAt?: string;
  updatedAt?: string;
  salePrice?: string;
  crmUrl?: string;
  contact?: LeadContactView;
  agents: LeadAgentView[];
  properties: LeadPropertyView[];
  events: LeadEventView[];
  agentCount: number;
  propertyCount: number;
  eventCount: number;
}

export interface LeadListView {
  id: string;
  leads: LeadView[];
  totalRecords: number;
  returnedRecords: number;
  truncated: boolean;
  generatedAt: string;
}

export interface PropertyAgentView {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
}

export interface PropertyView {
  id: string;
  internalId?: string;
  reference: string;
  title: string;
  status?: string;
  businessType?: string;
  propertyType?: string;
  condition?: string;
  typology?: string;
  bedrooms?: number;
  bathrooms?: number;
  price?: string;
  currency?: string;
  priceVisible?: boolean;
  sold?: boolean;
  visibleOnWebsite?: boolean;
  livingArea?: string;
  totalArea?: string;
  plotArea?: string;
  address?: string;
  location?: string;
  description?: string;
  energyRating?: string;
  photoUrl?: string;
  agent?: PropertyAgentView;
  features: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface PropertyListView {
  id: string;
  properties: PropertyView[];
  totalRecords: number;
  returnedRecords: number;
  truncated: boolean;
  generatedAt: string;
}
