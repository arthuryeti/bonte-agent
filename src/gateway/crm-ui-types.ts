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
